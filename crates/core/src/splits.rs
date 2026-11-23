use std::collections::{BTreeMap, BTreeSet, HashSet};

use entity::sea_orm_active_enums::LinkKind;
use entity::{categories, link_groups, transaction_splits, transactions};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, Set, TransactionTrait};

use crate::allocate::allocate;
use crate::error::{Error, Result, not_found};
use crate::transactions::{find_model, load_transaction, splits_by_transaction};
use crate::{BulkOutcome, Ledger, Split, Transaction};

impl Ledger {
    /// Gives each transaction one category for its whole amount, or none (`None`), in one go.
    /// Transactions that can't carry a category are skipped: transfer members and zero amounts.
    /// Like [`Ledger::set_splits`], a reimbursement group keeps sharing one set of categories.
    pub async fn set_category(&self, transaction_ids: &[i64], category_id: Option<i64>) -> Result<BulkOutcome> {
        let ids: BTreeSet<i64> = transaction_ids.iter().copied().collect();
        let txn = self.db.begin().await?;
        if let Some(c) = category_id {
            categories::Entity::find_by_id(c).one(&txn).await?.ok_or_else(|| not_found("category", c))?;
        }
        let txs =
            transactions::Entity::find().filter(transactions::Column::Id.is_in(ids.iter().copied())).all(&txn).await?;
        if let Some(missing) = ids.iter().find(|id| !txs.iter().any(|t| t.id == **id)) {
            return Err(not_found("transaction", *missing));
        }
        let groups: BTreeMap<i64, link_groups::Model> = link_groups::Entity::find()
            .filter(link_groups::Column::Id.is_in(txs.iter().filter_map(|t| t.link_group_id)))
            .all(&txn)
            .await?
            .into_iter()
            .map(|g| (g.id, g))
            .collect();
        let mut outcome = BulkOutcome::default();
        for tx in &txs {
            let group = tx.link_group_id.and_then(|id| groups.get(&id));
            let splits = match category_id {
                Some(_) if tx.amount_cents == 0 || group.is_some_and(|g| g.kind == LinkKind::Transfer) => {
                    outcome.skipped += 1;
                    continue;
                }
                Some(c) => vec![Split { category_id: c, amount_cents: tx.amount_cents }],
                None => Vec::new(),
            };
            set_member_splits(&txn, tx, group, &splits).await?;
            outcome.updated += 1;
        }
        txn.commit().await?;
        Ok(outcome)
    }

    /// Replaces all splits of a transaction. An empty list makes it uncategorized.
    ///
    /// Rules: splits add up exactly to the transaction amount, are non-zero, use each category
    /// once, and transfer members can't have splits. A reimbursement group shares its expenses'
    /// categories (see [`sync_reimbursement`]): changing an expense re-labels its payments back,
    /// and a payment can be divided over the group's categories; giving a payment another
    /// category, or none, gives the whole group that category, or none.
    pub async fn set_splits(&self, transaction_id: i64, splits: Vec<Split>) -> Result<Transaction> {
        let txn = self.db.begin().await?;
        let tx = find_model(&txn, transaction_id).await?;
        let group = match tx.link_group_id {
            Some(id) => link_groups::Entity::find_by_id(id).one(&txn).await?,
            None => None,
        };
        if !splits.is_empty() {
            if group.as_ref().is_some_and(|g| g.kind == LinkKind::Transfer) {
                return Err(Error::FailedPrecondition(format!(
                    "transaction #{transaction_id} is part of a transfer and can't be categorized"
                )));
            }
            validate_splits(&txn, tx.amount_cents, &splits).await?;
        }
        set_member_splits(&txn, &tx, group.as_ref(), &splits).await?;
        let result = load_transaction(&txn, transaction_id).await?;
        txn.commit().await?;
        Ok(result)
    }
}

async fn validate_splits(conn: &impl ConnectionTrait, amount_cents: i64, splits: &[Split]) -> Result<()> {
    let invalid = |msg: String| Err(Error::InvalidArgument(msg));
    if splits.iter().any(|s| s.amount_cents == 0) {
        return invalid("split amounts must not be zero".into());
    }
    let category_ids: HashSet<i64> = splits.iter().map(|s| s.category_id).collect();
    if category_ids.len() != splits.len() {
        return invalid("each category can only appear once in a transaction's splits".into());
    }
    let sum: i64 = splits.iter().map(|s| s.amount_cents).sum();
    if sum != amount_cents {
        return invalid(format!("splits add up to {sum} cents, but the transaction is {amount_cents} cents"));
    }
    let found = categories::Entity::find()
        .filter(categories::Column::Id.is_in(category_ids.iter().copied()))
        .count(conn)
        .await?;
    if found as usize != category_ids.len() {
        return Err(Error::NotFound("one of the split categories".into()));
    }
    Ok(())
}

pub(crate) async fn replace_splits(conn: &impl ConnectionTrait, transaction_id: i64, splits: &[Split]) -> Result<()> {
    transaction_splits::Entity::delete_many()
        .filter(transaction_splits::Column::TransactionId.eq(transaction_id))
        .exec(conn)
        .await?;
    if !splits.is_empty() {
        transaction_splits::Entity::insert_many(splits.iter().map(|s| transaction_splits::ActiveModel {
            transaction_id: Set(transaction_id),
            category_id: Set(s.category_id),
            amount_cents: Set(s.amount_cents),
            ..Default::default()
        }))
        .exec_without_returning(conn)
        .await?;
    }
    Ok(())
}

/// Sets one transaction's splits, keeping its reimbursement group (if any) on one set of categories.
/// A payment back may divide itself differently over the group's categories (Anna only paid for
/// the dinner, not the flight); giving it a category the expenses don't have, or none, gives the
/// whole group that category, or none.
async fn set_member_splits(
    conn: &impl ConnectionTrait,
    tx: &transactions::Model,
    group: Option<&link_groups::Model>,
    splits: &[Split],
) -> Result<()> {
    let Some(group) = group.filter(|g| g.kind == LinkKind::Reimbursement) else {
        return replace_splits(conn, tx.id, splits).await;
    };
    let expenses: Vec<transactions::Model> = transactions::Entity::find()
        .filter(transactions::Column::LinkGroupId.eq(group.id))
        .filter(transactions::Column::AmountCents.lt(0))
        .all(conn)
        .await?;
    let expense_ids: Vec<i64> = expenses.iter().map(|e| e.id).collect();
    let group_categories: HashSet<i64> =
        splits_by_transaction(conn, &expense_ids).await?.into_values().flatten().map(|s| s.category_id).collect();
    let within_group = !splits.is_empty() && splits.iter().all(|s| group_categories.contains(&s.category_id));
    if tx.amount_cents > 0 && !expenses.is_empty() && !within_group {
        let weights: Vec<(i64, i64)> = splits.iter().map(|s| (s.category_id, s.amount_cents.abs())).collect();
        for e in &expenses {
            replace_splits(conn, e.id, &to_splits(allocate(e.amount_cents, &weights))).await?;
        }
    } else {
        replace_splits(conn, tx.id, splits).await?;
    }
    sync_reimbursement(conn, group.id, false).await
}

fn to_splits(parts: Vec<(i64, i64)>) -> Vec<Split> {
    parts.into_iter().map(|(category_id, amount_cents)| Split { category_id, amount_cents }).collect()
}

/// Keeps a reimbursement group on one set of categories, the expenses': a payment back without a
/// category, or with one the expenses don't have, gets the expenses' categories with its amount
/// spread pro rata. A payment already divided over the expenses' categories keeps its division. With
/// `seed_from_payments` (when linking), uncategorized expenses first take the payments' categories
/// if no expense has one yet, so linking a categorized Tikkie to an uncategorized dinner keeps
/// the Tikkie's category. A group without expenses is left alone.
pub(crate) async fn sync_reimbursement(
    conn: &impl ConnectionTrait,
    group_id: i64,
    seed_from_payments: bool,
) -> Result<()> {
    let members = transactions::Entity::find().filter(transactions::Column::LinkGroupId.eq(group_id)).all(conn).await?;
    let ids: Vec<i64> = members.iter().map(|m| m.id).collect();
    let splits = splits_by_transaction(conn, &ids).await?;
    let expenses: Vec<&transactions::Model> = members.iter().filter(|m| m.amount_cents < 0).collect();
    let payments: Vec<&transactions::Model> = members.iter().filter(|m| m.amount_cents > 0).collect();
    if expenses.is_empty() {
        return Ok(());
    }
    // Weight per category = how much the given members put in it (BTreeMap for a stable order).
    let weights = |side: &[&transactions::Model]| -> Vec<(i64, i64)> {
        let mut by_category: BTreeMap<i64, i64> = BTreeMap::new();
        for m in side {
            for s in splits.get(&m.id).into_iter().flatten() {
                *by_category.entry(s.category_id).or_default() += s.amount_cents.abs();
            }
        }
        by_category.into_iter().filter(|&(_, w)| w > 0).collect()
    };
    let mut shared = weights(&expenses);
    if shared.is_empty() && seed_from_payments {
        shared = weights(&payments);
        for e in &expenses {
            replace_splits(conn, e.id, &to_splits(allocate(e.amount_cents, &shared))).await?;
        }
    }
    let allowed: HashSet<i64> = shared.iter().map(|&(category, _)| category).collect();
    for p in &payments {
        let current = splits.get(&p.id).cloned().unwrap_or_default();
        if !current.is_empty() && current.iter().all(|s| allowed.contains(&s.category_id)) {
            continue;
        }
        let wanted = to_splits(allocate(p.amount_cents, &shared));
        if wanted != current {
            replace_splits(conn, p.id, &wanted).await?;
        }
    }
    Ok(())
}
