//! The Tally server: gRPC (and gRPC-web for browsers) on one port.

mod config;
mod grpc;

use anyhow::{Context, Result};
use tally_core::Ledger;
use migration::{Migrator, MigratorTrait};
use sea_orm::Database;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn")))
        .init();

    let config = config::Config::from_env()?;
    let db = Database::connect(&config.database_url).await.context("connecting to the database")?;
    Migrator::up(&db, None).await.context("running migrations")?;

    tracing::info!(addr = %config.listen_addr, web_dir = ?config.web_dir, "listening");
    grpc::serve(Ledger::new(db), config.listen_addr, config.web_dir, async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("shutting down");
    })
    .await
}
