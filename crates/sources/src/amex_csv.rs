//! American Express Netherlands CSV export (`activity.csv`):
//!
//! ```text
//! Datum,Omschrijving,Bedrag
//! 11/19/2026,HARTELIJK BEDANKT VOOR UW BETALING,"-1019,66"
//! ```
//!
//! Dates are month-first despite the Dutch headers. AMEX shows charges as positive amounts;
//! we flip the sign so spending is negative.
//! Key: sha256(date | amount | description) with an occurrence suffix for identical rows.
//!
//! TODO: check how a pending charge shows up once one is in an export. If pending rows appear and
//! later change (amount, date or description), they would be imported twice.

use crate::parse::{collapse_whitespace, disambiguate, fingerprint, non_empty, parse_cents, parse_date, read_csv};
use crate::{NormalizedMutation, SourceError};

pub const ID: &str = "amex_csv";
const KEY_PREFIX: &str = "amex_csv:v1:";

pub fn parse(bytes: &[u8]) -> Result<Vec<NormalizedMutation>, SourceError> {
    let table = read_csv(bytes)?;
    let [date, description, amount] = table.columns(["Datum", "Omschrijving", "Bedrag"])?;

    let mut out = Vec::with_capacity(table.rows.len());
    for (line, cells) in &table.rows {
        let invalid = |message: String| SourceError::InvalidRow { line: *line, message };
        let booked_on = parse_date(&cells[date], "%m/%d/%Y").map_err(invalid)?;
        let amount_cents = -parse_cents(&cells[amount]).map_err(invalid)?;
        let description = collapse_whitespace(&cells[description]);
        let key = fingerprint(&[&booked_on.to_string(), &amount_cents.to_string(), &description]);
        out.push(NormalizedMutation {
            key: format!("{KEY_PREFIX}{key}"),
            booked_on,
            amount_cents,
            counterparty_name: non_empty(&description),
            counterparty_iban: None,
            description,
            raw: table.raw(cells),
        });
    }
    disambiguate(&mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/amex.csv");

    #[test]
    fn parses_the_real_format() {
        let rows = parse(FIXTURE).unwrap();
        assert_eq!(rows.len(), 7);

        let payment = &rows[0];
        assert_eq!(payment.booked_on, jiff::civil::date(2026, 11, 19), "dates are month-first");
        assert_eq!(payment.amount_cents, 101966, "a payment to AMEX is money coming in");

        let purchase = &rows[1];
        assert_eq!(purchase.amount_cents, -3499);
        assert_eq!(purchase.description, "BOL.COM UTRECHT", "padding is collapsed");
        assert_eq!(purchase.raw["Omschrijving"], "BOL.COM               UTRECHT");
        assert!(rows.iter().all(|r| r.key.starts_with("amex_csv:v1:")));
    }

    #[test]
    fn identical_rows_stay_two_rows() {
        let rows = parse(FIXTURE).unwrap();
        assert_eq!(rows[5].key, format!("{}#1", rows[4].key));
    }

    #[test]
    fn day_first_dates_are_rejected() {
        let err = parse(b"Datum,Omschrijving,Bedrag\n19/11/2026,X,\"1,00\"\n").unwrap_err();
        assert!(err.to_string().contains("expected %m/%d/%Y"), "{err}");
    }
}
