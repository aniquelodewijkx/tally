//! All use cases of Tally. This is the only crate that queries the database.
//!
//! Every public method on [`Ledger`] that writes runs in its own DB transaction and returns
//! domain types from [`model`], never entity models. Time values are jiff types; the generated
//! entities use chrono, and [`time`] converts at that boundary.

mod accounts;
mod allocate;
mod categories;
mod error;
mod imports;
mod links;
pub mod model;
mod reports;
mod rules;
mod splits;
mod time;
mod transactions;

pub use entity::sea_orm_active_enums::{CategoryKind, LinkKind, RuleDirection};
pub use error::{Error, Result};
pub use model::*;

use sea_orm::DatabaseConnection;

/// Entry point for all use cases.
#[derive(Clone, Debug)]
pub struct Ledger {
    db: DatabaseConnection,
}

impl Ledger {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }
}
