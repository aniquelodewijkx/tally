use jiff::civil::Date;
use sea_orm::{DbBackend, FromQueryResult, Statement};

use crate::error::{Error, Result};
use crate::time::{date_from_jiff, date_to_jiff};
use crate::{CategoryTotal, Ledger, TotalTarget};

/// Per month and category: the sum of splits. Transfers are excluded. Members of a reimbursement
/// group count in the month of the group's earliest expense, so a December Tikkie for a November
/// dinner corrects November. Transactions without splits land in "uncategorized in/out" by sign.
const CATEGORY_TOTALS: &str = r#"
WITH reportable AS (
    SELECT t.id,
           t.amount_cents,
           CASE WHEN g.kind = 'reimbursement' THEN
               COALESCE((SELECT min(e.booked_on) FROM transactions e
                         WHERE e.link_group_id = g.id AND e.amount_cents < 0), t.booked_on)
           ELSE t.booked_on END AS report_on
    FROM transactions t
    LEFT JOIN link_groups g ON g.id = t.link_group_id
    WHERE g.kind IS DISTINCT FROM 'transfer'
), in_range AS (
    SELECT * FROM reportable WHERE report_on BETWEEN $1 AND $2
)
SELECT date_trunc('month', r.report_on)::date AS month,
       s.category_id AS category_id,
       NULL::text AS bucket,
       sum(s.amount_cents)::bigint AS amount_cents,
       sum(LEAST(s.amount_cents, 0))::bigint AS spent_cents,
       sum(GREATEST(s.amount_cents, 0))::bigint AS received_cents
FROM in_range r
JOIN transaction_splits s ON s.transaction_id = r.id
GROUP BY 1, 2
UNION ALL
SELECT date_trunc('month', r.report_on)::date,
       NULL,
       CASE WHEN r.amount_cents >= 0 THEN 'in' ELSE 'out' END,
       sum(r.amount_cents)::bigint,
       sum(LEAST(r.amount_cents, 0))::bigint,
       sum(GREATEST(r.amount_cents, 0))::bigint
FROM in_range r
WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = r.id)
GROUP BY 1, 3
ORDER BY 1, 2, 3
"#;

impl Ledger {
    /// Category totals per month for transactions reported between `from` and `to` (inclusive).
    pub async fn category_totals(&self, from: Date, to: Date) -> Result<Vec<CategoryTotal>> {
        #[derive(FromQueryResult)]
        struct Row {
            month: chrono::NaiveDate,
            category_id: Option<i64>,
            bucket: Option<String>,
            amount_cents: i64,
            spent_cents: i64,
            received_cents: i64,
        }
        if from > to {
            return Err(Error::InvalidArgument("`from` must not be after `to`".into()));
        }
        let rows = Row::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            CATEGORY_TOTALS,
            [date_from_jiff(from).into(), date_from_jiff(to).into()],
        ))
        .all(&self.db)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| CategoryTotal {
                month: date_to_jiff(r.month),
                target: match (r.category_id, r.bucket.as_deref()) {
                    (Some(id), _) => TotalTarget::Category(id),
                    (None, Some("in")) => TotalTarget::UncategorizedIn,
                    _ => TotalTarget::UncategorizedOut,
                },
                amount_cents: r.amount_cents,
                spent_cents: r.spent_cents,
                received_cents: r.received_cents,
            })
            .collect())
    }
}
