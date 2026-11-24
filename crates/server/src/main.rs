//! The Tally server: gRPC (and gRPC-web for browsers) on one port.

mod auth;
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

    let auth = config.passkey_file.map(auth::Auth::new);
    if let Some(auth) = &auth {
        tracing::info!(file = %auth.path().display(), "passkey sign-in is on");
    }

    tracing::info!(addr = %config.listen_addr, web_dir = ?config.web_dir, "listening");
    grpc::serve(Ledger::new(db), auth, config.listen_addr, config.web_dir, async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("shutting down");
    })
    .await
}
