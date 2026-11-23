//! ING Netherlands CSV export (English, comma-separated, every field quoted, CRLF):
//!
//! ```text
//! "Date","Name / Description","Account","Counterparty","Code","Debit/credit","Amount (EUR)","Transaction type","Notifications"
//! "20261117","American Express","NL..INGB..","NL..AMEX..","IC","Debit","1019,66","SEPA direct debit","Name: American Express ..."
//! ```
//!
//! Amounts are unsigned; "Debit" means money left the account.
//! Key: sha256(date | amount | counterparty IBAN | name | notifications). Card payments carry a
//! terminal and transaction id in the notifications, so the key is unique in practice; rows that
//! are identical anyway get an occurrence suffix.

use crate::parse::{collapse_whitespace, disambiguate, fingerprint, non_empty, parse_cents, parse_date, read_csv};
use crate::{NormalizedMutation, SourceError};

pub const ID: &str = "ing_csv";
const KEY_PREFIX: &str = "ing_csv:v1:";

pub fn parse(bytes: &[u8]) -> Result<Vec<NormalizedMutation>, SourceError> {
    let table = read_csv(bytes)?;
    let [date, name, counterparty, direction, amount, notifications] = table.columns([
        "Date",
        "Name / Description",
        "Counterparty",
        "Debit/credit",
        "Amount (EUR)",
        "Notifications",
    ])?;

    let mut out = Vec::with_capacity(table.rows.len());
    for (line, cells) in &table.rows {
        let invalid = |message: String| SourceError::InvalidRow { line: *line, message };
        let booked_on = parse_date(&cells[date], "%Y%m%d").map_err(invalid)?;
        let magnitude = parse_cents(&cells[amount]).map_err(invalid)?;
        let amount_cents = match cells[direction].as_str() {
            "Debit" => -magnitude,
            "Credit" => magnitude,
            other => return Err(invalid(format!("expected Debit or Credit, got {other:?}"))),
        };
        let name = collapse_whitespace(&cells[name]);
        let notifications = collapse_whitespace(&cells[notifications]);
        let key = fingerprint(&[&cells[date], &amount_cents.to_string(), &cells[counterparty], &name, &notifications]);
        out.push(NormalizedMutation {
            key: format!("{KEY_PREFIX}{key}"),
            booked_on,
            amount_cents,
            counterparty_iban: non_empty(&cells[counterparty]),
            description: if notifications.is_empty() { name.clone() } else { notifications },
            counterparty_name: non_empty(&name),
            raw: table.raw(cells),
        });
    }
    disambiguate(&mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/ing.csv");

    #[test]
    fn parses_the_real_format() {
        let rows = parse(FIXTURE).unwrap();
        assert_eq!(rows.len(), 8);

        let amex = &rows[1];
        assert_eq!(amex.booked_on, jiff::civil::date(2026, 11, 17));
        assert_eq!(amex.amount_cents, -101966);
        assert_eq!(amex.counterparty_name.as_deref(), Some("American Express"));
        assert_eq!(amex.counterparty_iban.as_deref(), Some("NL11AMEX0000000001"));
        assert!(amex.description.starts_with("Name: American Express"));
        assert_eq!(amex.raw["Code"], "IC");

        let reimbursement = &rows[2];
        assert_eq!(reimbursement.amount_cents, 2900);
        assert!(rows.iter().all(|r| r.key.starts_with("ing_csv:v1:")));
    }

    #[test]
    fn identical_rows_stay_two_rows() {
        let rows = parse(FIXTURE).unwrap();
        assert_eq!(rows[6].key, format!("{}#1", rows[5].key));
    }

    #[test]
    fn keys_are_stable_across_overlapping_exports() {
        let full = parse(FIXTURE).unwrap();
        let text = std::str::from_utf8(FIXTURE).unwrap();
        let header_and_last_three: Vec<&str> =
            text.lines().take(1).chain(text.lines().skip(1).skip(full.len() - 3)).collect();
        let partial = parse(header_and_last_three.join("\r\n").as_bytes()).unwrap();
        let tail: Vec<&str> = full[full.len() - 3..].iter().map(|r| r.key.as_str()).collect();
        assert_eq!(partial.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), tail);
    }

    #[test]
    fn other_formats_are_rejected_with_the_headers_found() {
        let err = parse(b"\"Datum\",\"Bedrag\"\n\"20261114\",\"1,00\"\n").unwrap_err();
        assert_eq!(err.to_string(), "missing column \"Date\" (found: Datum, Bedrag)");
    }
}
