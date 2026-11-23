//! Conversions between the chrono types in the generated entities and the jiff types used everywhere else.
//! SeaORM 2.0 has no jiff support yet; once it does, this module can go.

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate};
use jiff::{Timestamp, civil::Date};

pub(crate) fn date_to_jiff(d: NaiveDate) -> Date {
    Date::new(d.year() as i16, d.month() as i8, d.day() as i8).expect("Postgres dates fit in jiff's range")
}

pub(crate) fn date_from_jiff(d: Date) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year().into(), d.month() as u32, d.day() as u32)
        .expect("jiff dates are valid chrono dates")
}

pub(crate) fn timestamp_to_jiff(t: DateTime<FixedOffset>) -> Timestamp {
    Timestamp::new(t.timestamp(), t.timestamp_subsec_nanos() as i32).expect("Postgres timestamps fit in jiff's range")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let d = Date::new(2026, 2, 28).unwrap();
        assert_eq!(date_to_jiff(date_from_jiff(d)), d);
        let t = DateTime::parse_from_rfc3339("2026-11-22T13:29:18.644+01:00").unwrap();
        assert_eq!(timestamp_to_jiff(t).to_string(), "2026-11-22T12:29:18.644Z");
    }
}
