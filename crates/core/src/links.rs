use std::collections::BTreeSet;

use entity::sea_orm_active_enums::LinkKind;
use entity::{accounts, link_groups, transaction_splits, transactions};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    Set, Statement, TransactionTrait,
};

use crate::error::{Error, Result, not_found};
use crate::splits::sync_reimbursement;
use crate::time::timestamp_to_jiff;
use crate::{BulkOutcome, Ledger, LinkGroup, TransferSuggestion};

/// How many days apart the two sides of a transfer may be booked.
const TRANSFER_WINDOW_DAYS: i32 = 5;

impl Ledger {
    pub async fn get_group(&self, id: i64) -> Result<LinkGroup> {
        load_group(&self.db, id).await
    }

    /// Confirms a group. Transfer members lose their splits; a reimbursement group shares one set
    /// of categories, its payments back taking the expenses' (see `sync_reimbursement`).
    /// A reimbursement group may take members from other reimbursement groups (a Tikkie linked to
    /// the wrong dinner moves); members of a transfer can't join another group. A one-sided transfer may name the account on its
    /// other side (`counter_account_id`), e.g. a savings pot that is never imported.
    pub async fn create_group(
        &self,
        kind: LinkKind,
        title: Option<String>,
        transaction_ids: &[i64],
        counter_account_id: Option<i64>,
    ) -> Result<LinkGroup> {
        let ids: BTreeSet<i64> = transaction_ids.iter().copied().collect();
        let txn = self.db.begin().await?;
        let members = load_members(&txn, &ids).await?;
        take_from_other_groups(&txn, kind, None, &members).await?;
        validate_group(kind, &members)?;
        validate_counter_account(&txn, kind, &members, counter_account_id).await?;
        let group = link_groups::ActiveModel {
            kind: Set(kind),
            title: Set(title.filter(|t| !t.trim().is_empty())),
            counter_account_id: Set(counter_account_id),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        attach(&txn, group.id, kind, &ids).await?;
        let result = load_group(&txn, group.id).await?;
        txn.commit().await?;
        Ok(result)
    }

    /// Marks each transaction as its own one-sided transfer, to or from `counter_account_id` (a pot)
    /// or an account you don't track (`None`). Skips transactions already linked, and those on
    /// the pot's own account.
    pub async fn mark_transfers(
        &self,
        transaction_ids: &[i64],
        counter_account_id: Option<i64>,
    ) -> Result<BulkOutcome> {
        let ids: BTreeSet<i64> = transaction_ids.iter().copied().collect();
        let txn = self.db.begin().await?;
        if let Some(counter) = counter_account_id {
            accounts::Entity::find_by_id(counter).one(&txn).await?.ok_or_else(|| not_found("account", counter))?;
        }
        let mut outcome = BulkOutcome::default();
        for m in load_members(&txn, &ids).await? {
            if m.link_group_id.is_some() || counter_account_id == Some(m.account_id) {
                outcome.skipped += 1;
                continue;
            }
            let group = link_groups::ActiveModel {
                kind: Set(LinkKind::Transfer),
                counter_account_id: Set(counter_account_id),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
            attach(&txn, group.id, LinkKind::Transfer, &BTreeSet::from([m.id])).await?;
            outcome.updated += 1;
        }
        txn.commit().await?;
        Ok(outcome)
    }

    /// Adds and removes members. The resulting group must still satisfy the rules of its kind.
    /// Like [`Ledger::create_group`], a reimbursement group takes members from other
    /// reimbursement groups.
    pub async fn update_group_members(&self, group_id: i64, add: &[i64], remove: &[i64]) -> Result<LinkGroup> {
        let txn = self.db.begin().await?;
        let group =
            link_groups::Entity::find_by_id(group_id).one(&txn).await?.ok_or_else(|| not_found("group", group_id))?;
        let current: BTreeSet<i64> = member_ids(&txn, group_id).await?.into_iter().collect();
        let remove: BTreeSet<i64> = remove.iter().copied().filter(|id| current.contains(id)).collect();
        let add: BTreeSet<i64> = add.iter().copied().filter(|id| !current.contains(id)).collect();

        let added = load_members(&txn, &add).await?;
        take_from_other_groups(&txn, group.kind, Some(group_id), &added).await?;
        let resulting: BTreeSet<i64> = current.difference(&remove).chain(add.iter()).copied().collect();
        let resulting_members = load_members(&txn, &resulting).await?;
        validate_group(group.kind, &resulting_members)?;
        // The named other side only applies while the transfer is one-sided. Once the real other
        // side is linked (e.g. after importing the savings account), the group names both accounts.
        let counter = group.counter_account_id.filter(|_| resulting_members.len() == 1);
        validate_counter_account(&txn, group.kind, &resulting_members, counter).await?;
        // Changing a group by hand makes it yours, even if a rule made it.
        if counter != group.counter_account_id || group.rule_id.is_some() {
            let mut active: link_groups::ActiveModel = group.clone().into();
            active.counter_account_id = Set(counter);
            active.rule_id = Set(None);
            active.update(&txn).await?;
        }

        if !remove.is_empty() {
            transactions::Entity::update_many()
                .col_expr(transactions::Column::LinkGroupId, Expr::value(Option::<i64>::None))
                .filter(transactions::Column::Id.is_in(remove))
                .exec(&txn)
                .await?;
        }
        attach(&txn, group_id, group.kind, &add).await?;
        if add.is_empty() && group.kind == LinkKind::Reimbursement {
            sync_reimbursement(&txn, group_id, false).await?;
        }
        let result = load_group(&txn, group_id).await?;
        txn.commit().await?;
        Ok(result)
    }

    /// Deletes the group; its members stay, unlinked (ON DELETE SET NULL).
    pub async fn delete_group(&self, id: i64) -> Result<()> {
        let res = link_groups::Entity::delete_by_id(id).exec(&self.db).await?;
        if res.rows_affected == 0 {
            return Err(not_found("group", id));
        }
        Ok(())
    }

    /// Pairs of unlinked transactions on two accounts with opposite amounts, booked at most
    /// 5 days apart: likely transfers, such as ING paying the AMEX bill. Computed on the fly.
    pub async fn suggest_transfers(&self) -> Result<Vec<TransferSuggestion>> {
        #[derive(FromQueryResult)]
        struct Row {
            outgoing_id: i64,
            incoming_id: i64,
        }
        let sql = r#"
            SELECT o.id AS outgoing_id, i.id AS incoming_id
            FROM transactions o
            JOIN transactions i
              ON i.amount_cents = -o.amount_cents
             AND i.account_id <> o.account_id
             AND i.booked_on BETWEEN o.booked_on - $1 AND o.booked_on + $1
            WHERE o.amount_cents < 0
              AND o.link_group_id IS NULL
              AND i.link_group_id IS NULL
            ORDER BY o.booked_on DESC, abs(i.booked_on - o.booked_on), i.id"#;
        let rows = Row::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            sql,
            [TRANSFER_WINDOW_DAYS.into()],
        ))
        .all(&self.db)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| TransferSuggestion { outgoing_id: r.outgoing_id, incoming_id: r.incoming_id })
            .collect())
    }
}

/// Group rules (#12): checked here because the schema can't express them.
fn validate_group(kind: LinkKind, members: &[transactions::Model]) -> Result<()> {
    let fail = |msg: &str| Err(Error::FailedPrecondition(msg.to_owned()));
    if members.is_empty() {
        return fail("a group needs at least one transaction; delete the group instead");
    }
    if kind == LinkKind::Transfer {
        match members {
            [_] => {}
            [a, b] => {
                if a.account_id == b.account_id {
                    return fail("the two sides of a transfer must be on different accounts");
                }
                if a.amount_cents + b.amount_cents != 0 {
                    return fail("the two sides of a transfer must add up to zero");
                }
            }
            _ => return fail("a transfer has one or two transactions"),
        }
    }
    Ok(())
}

async fn validate_counter_account(
    conn: &impl ConnectionTrait,
    kind: LinkKind,
    members: &[transactions::Model],
    counter_account_id: Option<i64>,
) -> Result<()> {
    let Some(counter) = counter_account_id else { return Ok(()) };
    if kind != LinkKind::Transfer {
        return Err(Error::InvalidArgument("only a transfer can name the account on its other side".into()));
    }
    match members {
        [m] if m.account_id == counter => {
            return Err(Error::FailedPrecondition("the other side of a transfer must be a different account".into()));
        }
        [_] => {}
        _ => {
            return Err(Error::FailedPrecondition(
                "only a one-sided transfer names its other account; a two-sided transfer has both already".into(),
            ));
        }
    }
    accounts::Entity::find_by_id(counter).one(conn).await?.ok_or_else(|| not_found("account", counter))?;
    Ok(())
}

/// Moves members of other reimbursement groups out of them, for a reimbursement group being made
/// (`target` None) or extended. A group left with fewer than two members is deleted; the others
/// re-sync their categories. Members of any other kind of group are refused.
async fn take_from_other_groups(
    conn: &impl ConnectionTrait,
    kind: LinkKind,
    target: Option<i64>,
    members: &[transactions::Model],
) -> Result<()> {
    let mut left: BTreeSet<i64> = BTreeSet::new();
    let mut moving: Vec<i64> = Vec::new();
    for m in members {
        let Some(old) = m.link_group_id.filter(|g| Some(*g) != target) else { continue };
        let group = link_groups::Entity::find_by_id(old).one(conn).await?.ok_or_else(|| not_found("group", old))?;
        if kind != LinkKind::Reimbursement || group.kind != LinkKind::Reimbursement {
            return Err(Error::FailedPrecondition(format!("transaction #{} is already in group #{old}", m.id)));
        }
        left.insert(old);
        moving.push(m.id);
    }
    if moving.is_empty() {
        return Ok(());
    }
    transactions::Entity::update_many()
        .col_expr(transactions::Column::LinkGroupId, Expr::value(Option::<i64>::None))
        .filter(transactions::Column::Id.is_in(moving))
        .exec(conn)
        .await?;
    for old in left {
        if member_ids(conn, old).await?.len() < 2 {
            link_groups::Entity::delete_by_id(old).exec(conn).await?;
        } else {
            sync_reimbursement(conn, old, false).await?;
        }
    }
    Ok(())
}

async fn attach(conn: &impl ConnectionTrait, group_id: i64, kind: LinkKind, ids: &BTreeSet<i64>) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    transactions::Entity::update_many()
        .col_expr(transactions::Column::LinkGroupId, Expr::value(group_id))
        .filter(transactions::Column::Id.is_in(ids.iter().copied()))
        .exec(conn)
        .await?;
    match kind {
        LinkKind::Transfer => {
            transaction_splits::Entity::delete_many()
                .filter(transaction_splits::Column::TransactionId.is_in(ids.iter().copied()))
                .exec(conn)
                .await?;
        }
        LinkKind::Reimbursement => sync_reimbursement(conn, group_id, true).await?,
    }
    Ok(())
}

async fn load_members(conn: &impl ConnectionTrait, ids: &BTreeSet<i64>) -> Result<Vec<transactions::Model>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let members = transactions::Entity::find()
        .filter(transactions::Column::Id.is_in(ids.iter().copied()))
        .order_by_asc(transactions::Column::Id)
        .all(conn)
        .await?;
    if let Some(missing) = ids.iter().find(|id| !members.iter().any(|m| m.id == **id)) {
        return Err(not_found("transaction", *missing));
    }
    Ok(members)
}

async fn member_ids(conn: &impl ConnectionTrait, group_id: i64) -> Result<Vec<i64>> {
    Ok(transactions::Entity::find()
        .filter(transactions::Column::LinkGroupId.eq(group_id))
        .order_by_asc(transactions::Column::Id)
        .all(conn)
        .await?
        .into_iter()
        .map(|m| m.id)
        .collect())
}

async fn load_group(conn: &impl ConnectionTrait, id: i64) -> Result<LinkGroup> {
    let g = link_groups::Entity::find_by_id(id).one(conn).await?.ok_or_else(|| not_found("group", id))?;
    Ok(LinkGroup {
        id: g.id,
        kind: g.kind,
        title: g.title,
        transaction_ids: member_ids(conn, id).await?,
        counter_account_id: g.counter_account_id,
        created_at: timestamp_to_jiff(g.created_at),
    })
}
