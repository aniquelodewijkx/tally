//! Each test gets its own freshly migrated database on the server in TEST_DATABASE_URL,
//! so tests run in parallel without seeing each other's data.

use tally_core::{Ledger, Transaction, TransactionFilter};
use migration::{Migrator, MigratorTrait};
use sea_orm::{ConnectOptions, ConnectionTrait, Database};

pub async fn ledger() -> Ledger {
    let admin_url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL is not set: run the tests with `test-all` (scripts/with-ephemeral-postgres.sh)");
    let name = format!("test_{}", uuid::Uuid::new_v4().simple());
    let admin = Database::connect(options(&admin_url)).await.expect("connect to the test server");
    admin.execute_unprepared(&format!("CREATE DATABASE {name}")).await.expect("create test database");
    admin.close().await.ok();

    let db = Database::connect(options(&with_database(&admin_url, &name))).await.expect("connect to test database");
    Migrator::up(&db, None).await.expect("migrate test database");
    Ledger::new(db)
}

fn options(url: &str) -> ConnectOptions {
    let mut opts = ConnectOptions::new(url.to_owned());
    opts.max_connections(2).sqlx_logging(false);
    opts
}

/// Replaces the database name in a postgres URL, keeping any query string (e.g. `?host=/socket/dir`).
fn with_database(url: &str, name: &str) -> String {
    let (base, query) = url.split_once('?').map_or((url, None), |(b, q)| (b, Some(q)));
    let (server, _) = base.rsplit_once('/').expect("database URL has a path");
    match query {
        Some(q) => format!("{server}/{name}?{q}"),
        None => format!("{server}/{name}"),
    }
}

/// An ING export in the real format. Rows: (yyyymmdd, name, "Debit" | "Credit", amount like "145,00").
pub fn ing(rows: &[(&str, &str, &str, &str)]) -> Vec<u8> {
    let mut out = String::from(
        "\"Date\",\"Name / Description\",\"Account\",\"Counterparty\",\"Code\",\"Debit/credit\",\"Amount (EUR)\",\"Transaction type\",\"Notifications\"\r\n",
    );
    for (date, name, direction, amount) in rows {
        out.push_str(&format!(
            "\"{date}\",\"{name}\",\"NL00INGB0001234567\",\"\",\"GT\",\"{direction}\",\"{amount}\",\"Online Banking\",\"Description: {name}\"\r\n"
        ));
    }
    out.into_bytes()
}

/// An AMEX export in the real format. Rows: (mm/dd/yyyy, description, amount like "34,99").
/// Charges are positive, payments to AMEX negative, as in the real export.
pub fn amex(rows: &[(&str, &str, &str)]) -> Vec<u8> {
    let mut out = String::from("Datum,Omschrijving,Bedrag\n");
    for (date, description, amount) in rows {
        out.push_str(&format!("{date},{description},\"{amount}\"\n"));
    }
    out.into_bytes()
}

/// The single transaction whose description or counterparty contains `text`.
pub async fn tx(l: &Ledger, text: &str) -> Transaction {
    let filter = TransactionFilter { search: Some(text.into()), ..Default::default() };
    let mut found = l.list_transactions(&filter).await.unwrap();
    assert_eq!(found.len(), 1, "expected one transaction matching {text:?}");
    found.remove(0)
}

pub fn date(y: i16, m: i8, d: i8) -> jiff::civil::Date {
    jiff::civil::date(y, m, d)
}
