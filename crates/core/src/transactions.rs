use std::collections::HashMap;

use entity::sea_orm_active_enums::LinkKind;
use entity::{link_groups, transaction_splits, transactions};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, Set};

use crate::error::{Result, not_found};
use crate::time::{date_from_jiff, date_to_jiff};
use crate::{Ledger, Split, Transaction, TransactionFilter};

impl Ledger {
    /// All transactions matching the filter, newest first.
    pub async fn list_transactions(&self, filter: &TransactionFilter) -> Result<Vec<Transaction>> {
        use transactions::Column as C;
        let mut cond = Condition::all();
        if let Some(id) = filter.account_id {
            cond = cond.add(C::AccountId.eq(id));
        }
        if let Some(from) = filter.booked_from {
            cond = cond.add(C::BookedOn.gte(date_from_jiff(from)));
        }
        if let Some(to) = filter.booked_to {
            cond = cond.add(C::BookedOn.lte(date_from_jiff(to)));
        }
        if let Some(id) = filter.link_group_id {
            cond = cond.add(C::LinkGroupId.eq(id));
        }
        if let Some(account_id) = filter.counter_account_id {
            cond = cond.add(
                C::LinkGroupId.in_subquery(
                    Query::select()
                        .column(link_groups::Column::Id)
                        .from(link_groups::Entity)
                        .and_where(link_groups::Column::CounterAccountId.eq(account_id))
                        .to_owned(),
                ),
            );
        }
        if let Some(category_id) = filter.category_id {
            cond = cond.add(
                C::Id.in_subquery(
                    Query::select()
                        .column(transaction_splits::Column::TransactionId)
                        .from(transaction_splits::Entity)
                        .and_where(transaction_splits::Column::CategoryId.eq(category_id))
                        .to_owned(),
                ),
            );
        }
        if filter.uncategorized_only {
            cond = cond
                .add(
                    C::Id.not_in_subquery(
                        Query::select()
                            .column(transaction_splits::Column::TransactionId)
                            .from(transaction_splits::Entity)
                            .to_owned(),
                    ),
                )
                .add(
                    Condition::any().add(C::LinkGroupId.is_null()).add(
                        C::LinkGroupId.in_subquery(
                            Query::select()
                                .column(link_groups::Column::Id)
                                .from(link_groups::Entity)
                                .and_where(link_groups::Column::Kind.eq(LinkKind::Reimbursement))
                                .to_owned(),
                        ),
                    ),
                );
        }
        if let Some(search) = filter.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let pattern = format!("%{}%", search.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            cond = cond.add(
                Condition::any()
                    .add(Expr::col(C::Description).ilike(pattern.clone()))
                    .add(Expr::col(C::CounterpartyName).ilike(pattern)),
            );
        }

        let rows = transactions::Entity::find()
            .filter(cond)
            .order_by_desc(C::BookedOn)
            .order_by_desc(C::Id)
            .all(&self.db)
            .await?;
        with_splits(&self.db, rows).await
    }

    pub async fn get_transaction(&self, id: i64) -> Result<Transaction> {
        load_transaction(&self.db, id).await
    }

    pub async fn set_notes(&self, id: i64, notes: Option<String>) -> Result<Transaction> {
        let model = find_model(&self.db, id).await?;
        let mut active: transactions::ActiveModel = model.into();
        active.notes = Set(notes.filter(|n| !n.trim().is_empty()));
        active.update(&self.db).await?;
        load_transaction(&self.db, id).await
    }
}

pub(crate) async fn find_model(conn: &impl ConnectionTrait, id: i64) -> Result<transactions::Model> {
    transactions::Entity::find_by_id(id).one(conn).await?.ok_or_else(|| not_found("transaction", id))
}

pub(crate) async fn load_transaction(conn: &impl ConnectionTrait, id: i64) -> Result<Transaction> {
    let model = find_model(conn, id).await?;
    Ok(with_splits(conn, vec![model]).await?.remove(0))
}

pub(crate) async fn splits_by_transaction(
    conn: &impl ConnectionTrait,
    ids: &[i64],
) -> Result<HashMap<i64, Vec<Split>>> {
    let mut map: HashMap<i64, Vec<Split>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = transaction_splits::Entity::find()
        .filter(transaction_splits::Column::TransactionId.is_in(ids.iter().copied()))
        .order_by_asc(transaction_splits::Column::Id)
        .all(conn)
        .await?;
    for s in rows {
        map.entry(s.transaction_id)
            .or_default()
            .push(Split { category_id: s.category_id, amount_cents: s.amount_cents });
    }
    Ok(map)
}

pub(crate) async fn with_splits(
    conn: &impl ConnectionTrait,
    rows: Vec<transactions::Model>,
) -> Result<Vec<Transaction>> {
    let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
    let mut splits = splits_by_transaction(conn, &ids).await?;
    let rule_of: HashMap<i64, i64> = if ids.is_empty() {
        HashMap::new()
    } else {
        transaction_splits::Entity::find()
            .filter(transaction_splits::Column::TransactionId.is_in(ids.iter().copied()))
            .filter(transaction_splits::Column::RuleId.is_not_null())
            .all(conn)
            .await?
            .into_iter()
            .filter_map(|s| s.rule_id.map(|r| (s.transaction_id, r)))
            .collect()
    };
    let group_ids: Vec<i64> = rows.iter().filter_map(|r| r.link_group_id).collect();
    let groups: HashMap<i64, link_groups::Model> = if group_ids.is_empty() {
        HashMap::new()
    } else {
        link_groups::Entity::find()
            .filter(link_groups::Column::Id.is_in(group_ids))
            .all(conn)
            .await?
            .into_iter()
            .map(|g| (g.id, g))
            .collect()
    };
    Ok(rows
        .into_iter()
        .map(|m| Transaction {
            link_kind: m.link_group_id.and_then(|id| groups.get(&id)).map(|g| g.kind),
            link_title: m.link_group_id.and_then(|id| groups.get(&id)).and_then(|g| g.title.clone()),
            link_counter_account_id: m.link_group_id.and_then(|id| groups.get(&id)).and_then(|g| g.counter_account_id),
            splits: splits.remove(&m.id).unwrap_or_default(),
            rule_id: rule_of
                .get(&m.id)
                .copied()
                .or_else(|| m.link_group_id.and_then(|id| groups.get(&id)).and_then(|g| g.rule_id)),
            id: m.id,
            account_id: m.account_id,
            import_batch_id: m.import_batch_id,
            booked_on: date_to_jiff(m.booked_on),
            amount_cents: m.amount_cents,
            counterparty_name: m.counterparty_name,
            counterparty_iban: m.counterparty_iban,
            description: m.description,
            link_group_id: m.link_group_id,
            notes: m.notes,
        })
        .collect())
}
