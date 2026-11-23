//! Auto-label rules: "counterparty contains <pattern> -> category", or "-> transfer to a pot".
//!
//! Rules only fill blanks: they label transactions without splits that aren't in a link group
//! (transfers, reimbursements). What they create remembers the rule (`rule_id` on the split, or on
//! the transfer's link group), so the UI can show it, a rule's new target can move its own labels,
//! and your own choices are never touched.

use std::collections::{BTreeSet, HashMap};

use entity::sea_orm_active_enums::{LinkKind, RuleDirection};
use entity::{accounts, categories, link_groups, rules, transaction_splits, transactions};
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};

use crate::error::{Error, Result, not_found};
use crate::splits::sync_reimbursement;
use crate::time::timestamp_to_jiff;
use crate::transactions::with_splits;
use crate::{Ledger, MatchState, NewRule, Rule, RuleMatch, RulePreview, RuleScope, RuleTarget};

const INSERT_CHUNK: usize = 1000;
/// Most matches a preview lists (counts always cover all of them).
const PREVIEW_LIMIT: usize = 250;

/// How patterns are stored and names compared: lowercase, trimmed, single spaces.
pub(crate) fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn matches(rule: &rules::Model, account_id: i64, amount_cents: i64, name: &str) -> bool {
    let direction_ok = match rule.direction {
        Some(RuleDirection::Out) => amount_cents < 0,
        Some(RuleDirection::In) => amount_cents > 0,
        None => true,
    };
    let size = amount_cents.abs();
    direction_ok
        && rule.account_id.is_none_or(|a| a == account_id)
        && rule.min_amount_cents.is_none_or(|min| size >= min)
        && rule.max_amount_cents.is_none_or(|max| size <= max)
        && name.contains(&rule.pattern)
}

/// How narrow a rule's scope is: each of account, direction, minimum and maximum counts once.
fn narrowness(r: &rules::Model) -> u8 {
    [r.account_id.is_some(), r.direction.is_some(), r.min_amount_cents.is_some(), r.max_amount_cents.is_some()]
        .into_iter()
        .map(u8::from)
        .sum()
}

/// The rule that labels a transaction: the longest pattern contained in its counterparty name wins,
/// then the narrower rule (limited to an account, a direction or an amount range), then the newest.
pub(crate) fn best_rule<'a>(
    rules: &'a [rules::Model],
    account_id: i64,
    amount_cents: i64,
    name: &str,
) -> Option<&'a rules::Model> {
    let name = normalize(name);
    rules
        .iter()
        .filter(|r| matches(r, account_id, amount_cents, &name))
        .max_by_key(|r| (r.pattern.len(), narrowness(r), r.id))
}

fn target_of(r: &rules::Model) -> RuleTarget {
    match (r.category_id, r.counter_account_id) {
        (_, Some(pot)) => RuleTarget::Transfer(pot),
        (Some(category), None) => RuleTarget::Category(category),
        (None, None) => unreachable!("the rules_one_target constraint guarantees a target"),
    }
}

/// The name rules look at: the counterparty, or the description when a row has none.
fn rule_name(t: &transactions::Model) -> &str {
    t.counterparty_name.as_deref().unwrap_or(&t.description)
}

/// Transactions rules may label: no splits yet and not part of a transfer or reimbursement group.
async fn unlabelled(conn: &impl ConnectionTrait, batch_id: Option<i64>) -> Result<Vec<transactions::Model>> {
    let mut query = transactions::Entity::find()
        .filter(transactions::Column::LinkGroupId.is_null())
        .filter(transactions::Column::AmountCents.ne(0))
        .filter(
            transactions::Column::Id.not_in_subquery(
                Query::select()
                    .column(transaction_splits::Column::TransactionId)
                    .from(transaction_splits::Entity)
                    .to_owned(),
            ),
        )
        .order_by_desc(transactions::Column::BookedOn)
        .order_by_desc(transactions::Column::Id);
    if let Some(id) = batch_id {
        query = query.filter(transactions::Column::ImportBatchId.eq(id));
    }
    Ok(query.all(conn).await?)
}

/// Which transactions to label.
pub(crate) enum Scope {
    /// The new rows of one import.
    Batch(i64),
    /// Rows this rule wins (right after creating it).
    Rule(i64),
}

/// Labels unlabelled transactions in `scope` with their best rule: a category split, or a one-sided
/// transfer to the rule's pot. Returns how many transactions it labelled.
pub(crate) async fn apply_rules(conn: &impl ConnectionTrait, scope: Scope) -> Result<u64> {
    let all = rules::Entity::find().all(conn).await?;
    if all.is_empty() {
        return Ok(0);
    }
    let batch = match scope {
        Scope::Batch(id) => Some(id),
        Scope::Rule(_) => None,
    };
    let mut splits = Vec::new();
    let mut transfers = Vec::new();
    for t in unlabelled(conn, batch).await? {
        let Some(rule) = best_rule(&all, t.account_id, t.amount_cents, rule_name(&t)) else { continue };
        if let Scope::Rule(id) = scope
            && rule.id != id
        {
            continue;
        }
        match target_of(rule) {
            RuleTarget::Category(category_id) => splits.push(transaction_splits::ActiveModel {
                transaction_id: Set(t.id),
                category_id: Set(category_id),
                amount_cents: Set(t.amount_cents),
                rule_id: Set(Some(rule.id)),
                ..Default::default()
            }),
            // A transfer's other side must be a different account.
            RuleTarget::Transfer(pot) if pot != t.account_id => transfers.push((t.id, pot, rule.id)),
            RuleTarget::Transfer(_) => {}
        }
    }
    let count = (splits.len() + transfers.len()) as u64;
    for chunk in splits.chunks(INSERT_CHUNK) {
        transaction_splits::Entity::insert_many(chunk.to_vec()).exec_without_returning(conn).await?;
    }
    for (transaction_id, pot, rule_id) in transfers {
        let group = link_groups::ActiveModel {
            kind: Set(LinkKind::Transfer),
            counter_account_id: Set(Some(pot)),
            rule_id: Set(Some(rule_id)),
            ..Default::default()
        }
        .insert(conn)
        .await?;
        transactions::Entity::update_many()
            .col_expr(transactions::Column::LinkGroupId, Expr::value(group.id))
            .filter(transactions::Column::Id.eq(transaction_id))
            .exec(conn)
            .await?;
    }
    Ok(count)
}

/// Labels set by each rule: category splits plus transfers it made.
async fn label_counts(conn: &impl ConnectionTrait) -> Result<HashMap<i64, u64>> {
    let mut counts: HashMap<i64, u64> = HashMap::new();
    let splits = transaction_splits::Entity::find()
        .select_only()
        .column(transaction_splits::Column::RuleId)
        .column_as(Expr::from(Func::count(Expr::col(transaction_splits::Column::Id))), "labels")
        .filter(transaction_splits::Column::RuleId.is_not_null())
        .group_by(transaction_splits::Column::RuleId)
        .into_tuple::<(Option<i64>, i64)>()
        .all(conn)
        .await?;
    let groups = link_groups::Entity::find()
        .select_only()
        .column(link_groups::Column::RuleId)
        .column_as(Expr::from(Func::count(Expr::col(link_groups::Column::Id))), "labels")
        .filter(link_groups::Column::RuleId.is_not_null())
        .group_by(link_groups::Column::RuleId)
        .into_tuple::<(Option<i64>, i64)>()
        .all(conn)
        .await?;
    for (id, n) in splits.into_iter().chain(groups) {
        if let Some(id) = id {
            *counts.entry(id).or_default() += n as u64;
        }
    }
    Ok(counts)
}

impl Ledger {
    /// All rules, alphabetical, each with how many labels it set.
    pub async fn list_rules(&self) -> Result<Vec<Rule>> {
        let counts = label_counts(&self.db).await?;
        let rows = rules::Entity::find().order_by_asc(rules::Column::Pattern).all(&self.db).await?;
        Ok(rows.into_iter().map(|r| to_domain(&r, counts.get(&r.id).copied().unwrap_or(0))).collect())
    }

    /// Every transaction a rule with this pattern and scope matches, newest first, each with what the
    /// rule would do: label it, it already did (`rule_id`, when previewing an existing rule), or
    /// leave it alone because it's already categorized or linked.
    pub async fn preview_rule(&self, scope: &RuleScope, rule_id: Option<i64>) -> Result<RulePreview> {
        validate_amounts(scope.min_amount_cents, scope.max_amount_cents)?;
        let probe = rules::Model {
            id: 0,
            pattern: required_pattern(&scope.pattern)?,
            category_id: None,
            counter_account_id: None,
            direction: scope.direction,
            account_id: scope.account_id,
            min_amount_cents: scope.min_amount_cents,
            max_amount_cents: scope.max_amount_cents,
            created_at: chrono::Utc::now().into(),
        };
        let hits: Vec<transactions::Model> = transactions::Entity::find()
            .order_by_desc(transactions::Column::BookedOn)
            .order_by_desc(transactions::Column::Id)
            .all(&self.db)
            .await?
            .into_iter()
            .filter(|t| matches(&probe, t.account_id, t.amount_cents, &normalize(rule_name(t))))
            .collect();
        let mut preview = RulePreview { will_label: 0, labelled_by_rule: 0, handled: 0, matches: Vec::new() };
        for transaction in with_splits(&self.db, hits).await? {
            let state = if rule_id.is_some() && transaction.rule_id == rule_id {
                preview.labelled_by_rule += 1;
                MatchState::LabelledByRule
            } else if !transaction.splits.is_empty()
                || transaction.link_group_id.is_some()
                || transaction.amount_cents == 0
            {
                preview.handled += 1;
                MatchState::Handled
            } else {
                preview.will_label += 1;
                MatchState::WillLabel
            };
            if preview.matches.len() < PREVIEW_LIMIT {
                preview.matches.push(RuleMatch { transaction, state });
            }
        }
        Ok(preview)
    }

    /// Creates a rule and, with `apply_to_existing`, labels the unlabelled transactions it wins.
    /// Returns the rule and how many transactions it labelled.
    pub async fn create_rule(&self, new: NewRule, apply_to_existing: bool) -> Result<(Rule, u64)> {
        let pattern = required_pattern(&new.pattern)?;
        validate_amounts(new.min_amount_cents, new.max_amount_cents)?;
        let txn = self.db.begin().await?;
        validate_refs(&txn, new.target, new.account_id).await?;
        let duplicate = rules::Entity::find()
            .filter(rules::Column::Pattern.eq(&pattern))
            .filter(match new.direction {
                Some(d) => rules::Column::Direction.eq(d),
                None => rules::Column::Direction.is_null(),
            })
            .filter(match new.account_id {
                Some(a) => rules::Column::AccountId.eq(a),
                None => rules::Column::AccountId.is_null(),
            })
            .filter(match new.min_amount_cents {
                Some(v) => rules::Column::MinAmountCents.eq(v),
                None => rules::Column::MinAmountCents.is_null(),
            })
            .filter(match new.max_amount_cents {
                Some(v) => rules::Column::MaxAmountCents.eq(v),
                None => rules::Column::MaxAmountCents.is_null(),
            })
            .one(&txn)
            .await?;
        if duplicate.is_some() {
            return Err(Error::FailedPrecondition(format!("there's already a rule for \"{pattern}\" with this scope")));
        }
        let (category_id, counter_account_id) = target_columns(new.target);
        let rule = rules::ActiveModel {
            pattern: Set(pattern),
            category_id: Set(category_id),
            counter_account_id: Set(counter_account_id),
            direction: Set(new.direction),
            account_id: Set(new.account_id),
            min_amount_cents: Set(new.min_amount_cents),
            max_amount_cents: Set(new.max_amount_cents),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        let labelled = if apply_to_existing { apply_rules(&txn, Scope::Rule(rule.id)).await? } else { 0 };
        txn.commit().await?;
        tracing::info!(rule = rule.id, labelled, "created rule");
        Ok((to_domain(&rule, labelled), labelled))
    }

    /// Changes a rule. A new category (or pot) moves the labels this rule set; switching between a
    /// category and a pot leaves its earlier labels in place as yours. Labels you set never change.
    pub async fn update_rule(&self, id: i64, new: NewRule) -> Result<Rule> {
        let pattern = required_pattern(&new.pattern)?;
        validate_amounts(new.min_amount_cents, new.max_amount_cents)?;
        let txn = self.db.begin().await?;
        let current = rules::Entity::find_by_id(id).one(&txn).await?.ok_or_else(|| not_found("rule", id))?;
        validate_refs(&txn, new.target, new.account_id).await?;
        match (target_of(&current), new.target) {
            (RuleTarget::Category(old), RuleTarget::Category(category)) if old != category => {
                transaction_splits::Entity::update_many()
                    .col_expr(transaction_splits::Column::CategoryId, Expr::value(category))
                    .filter(transaction_splits::Column::RuleId.eq(id))
                    .exec(&txn)
                    .await?;
                // A reimbursement group shares its expenses' categories: its payments back follow.
                let moved: Vec<i64> = transaction_splits::Entity::find()
                    .filter(transaction_splits::Column::RuleId.eq(id))
                    .all(&txn)
                    .await?
                    .into_iter()
                    .map(|s| s.transaction_id)
                    .collect();
                let group_ids: BTreeSet<i64> = transactions::Entity::find()
                    .filter(transactions::Column::Id.is_in(moved))
                    .all(&txn)
                    .await?
                    .into_iter()
                    .filter_map(|t| t.link_group_id)
                    .collect();
                for g in link_groups::Entity::find().filter(link_groups::Column::Id.is_in(group_ids)).all(&txn).await? {
                    if g.kind == LinkKind::Reimbursement {
                        sync_reimbursement(&txn, g.id, false).await?;
                    }
                }
            }
            (RuleTarget::Transfer(old), RuleTarget::Transfer(pot)) if old != pot => {
                link_groups::Entity::update_many()
                    .col_expr(link_groups::Column::CounterAccountId, Expr::value(pot))
                    .filter(link_groups::Column::RuleId.eq(id))
                    .filter(link_groups::Column::CounterAccountId.is_not_null())
                    .exec(&txn)
                    .await?;
            }
            (RuleTarget::Category(_), RuleTarget::Transfer(_)) | (RuleTarget::Transfer(_), RuleTarget::Category(_)) => {
                transaction_splits::Entity::update_many()
                    .col_expr(transaction_splits::Column::RuleId, Expr::value(Option::<i64>::None))
                    .filter(transaction_splits::Column::RuleId.eq(id))
                    .exec(&txn)
                    .await?;
                link_groups::Entity::update_many()
                    .col_expr(link_groups::Column::RuleId, Expr::value(Option::<i64>::None))
                    .filter(link_groups::Column::RuleId.eq(id))
                    .exec(&txn)
                    .await?;
            }
            _ => {}
        }
        let (category_id, counter_account_id) = target_columns(new.target);
        let mut active: rules::ActiveModel = current.into();
        active.pattern = Set(pattern);
        active.category_id = Set(category_id);
        active.counter_account_id = Set(counter_account_id);
        active.direction = Set(new.direction);
        active.account_id = Set(new.account_id);
        active.min_amount_cents = Set(new.min_amount_cents);
        active.max_amount_cents = Set(new.max_amount_cents);
        let rule = active.update(&txn).await?;
        let labels = label_counts(&txn).await?.get(&id).copied().unwrap_or(0);
        txn.commit().await?;
        Ok(to_domain(&rule, labels))
    }

    /// Deletes a rule. The labels it set stay, as if you had set them yourself.
    pub async fn delete_rule(&self, id: i64) -> Result<()> {
        let res = rules::Entity::delete_by_id(id).exec(&self.db).await?;
        if res.rows_affected == 0 {
            return Err(not_found("rule", id));
        }
        Ok(())
    }
}

fn required_pattern(pattern: &str) -> Result<String> {
    let p = normalize(pattern);
    if p.is_empty() {
        return Err(Error::InvalidArgument("a rule needs some text to match".into()));
    }
    Ok(p)
}

fn validate_amounts(min: Option<i64>, max: Option<i64>) -> Result<()> {
    if min.is_some_and(|v| v < 0) || max.is_some_and(|v| v < 0) {
        return Err(Error::InvalidArgument("amounts in a rule are sizes, so they can't be negative".into()));
    }
    if let (Some(min), Some(max)) = (min, max)
        && min > max
    {
        return Err(Error::InvalidArgument("the minimum amount is larger than the maximum".into()));
    }
    Ok(())
}

fn target_columns(target: RuleTarget) -> (Option<i64>, Option<i64>) {
    match target {
        RuleTarget::Category(c) => (Some(c), None),
        RuleTarget::Transfer(pot) => (None, Some(pot)),
    }
}

async fn validate_refs(conn: &impl ConnectionTrait, target: RuleTarget, account_id: Option<i64>) -> Result<()> {
    match target {
        RuleTarget::Category(c) => {
            categories::Entity::find_by_id(c).one(conn).await?.ok_or_else(|| not_found("category", c))?;
        }
        RuleTarget::Transfer(pot) => {
            accounts::Entity::find_by_id(pot).one(conn).await?.ok_or_else(|| not_found("pot", pot))?;
            if account_id == Some(pot) {
                return Err(Error::InvalidArgument("a rule can't move money to the account it watches".into()));
            }
        }
    }
    if let Some(a) = account_id {
        accounts::Entity::find_by_id(a).one(conn).await?.ok_or_else(|| not_found("account", a))?;
    }
    Ok(())
}

fn to_domain(r: &rules::Model, labels: u64) -> Rule {
    Rule {
        id: r.id,
        pattern: r.pattern.clone(),
        target: target_of(r),
        direction: r.direction,
        account_id: r.account_id,
        min_amount_cents: r.min_amount_cents,
        max_amount_cents: r.max_amount_cents,
        labels,
        created_at: timestamp_to_jiff(r.created_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: i64, pattern: &str, direction: Option<RuleDirection>, account_id: Option<i64>) -> rules::Model {
        rules::Model {
            id,
            pattern: pattern.into(),
            category_id: Some(id * 10),
            counter_account_id: None,
            min_amount_cents: None,
            max_amount_cents: None,
            direction,
            account_id,
            created_at: chrono::Utc::now().into(),
        }
    }

    #[test]
    fn longest_pattern_wins_then_narrower_scope_then_newest() {
        let rules = [
            rule(1, "ah", None, None),
            rule(2, "ah to go", None, None),
            rule(3, "albert heijn", None, None),
            rule(4, "tikkie", Some(RuleDirection::Out), None),
            rule(5, "albert heijn", None, Some(7)),
        ];
        let best = |name: &str, amount: i64, account: i64| best_rule(&rules, account, amount, name).map(|r| r.id);
        assert_eq!(best("AH TO GO   SCHIPHOL", -450, 1), Some(2), "longer pattern, whitespace folded");
        assert_eq!(best("ALBERT HEIJN 1001 AMSTERDAM NLD", -2572, 1), Some(3));
        assert_eq!(
            best("ALBERT HEIJN 1001 AMSTERDAM NLD", -2572, 7),
            Some(5),
            "account-specific rule beats general one"
        );
        assert_eq!(best("Tikkie", -1250, 1), Some(4));
        assert_eq!(best("Tikkie", 1250, 1), None, "money-out rule ignores incoming money");
        assert_eq!(best("Restaurant De Kas", -15000, 1), None);
    }

    #[test]
    fn amount_ranges_narrow_a_rule() {
        let mut small = rule(1, "tikkie", Some(RuleDirection::Out), None);
        small.max_amount_cents = Some(1500);
        let mut big = rule(2, "tikkie", Some(RuleDirection::Out), None);
        big.min_amount_cents = Some(5000);
        let any = rule(3, "tikkie", Some(RuleDirection::Out), None);
        let rules = [small, big, any];
        let best = |amount: i64| best_rule(&rules, 1, amount, "Tikkie").map(|r| r.id);
        assert_eq!(best(-1250), Some(1), "up to 15 euro");
        assert_eq!(best(-1500), Some(1), "inclusive");
        assert_eq!(best(-3000), Some(3), "falls back to the rule without a range");
        assert_eq!(best(-5000), Some(2));
    }
}
