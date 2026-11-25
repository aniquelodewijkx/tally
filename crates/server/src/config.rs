use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};

pub struct Config {
    pub database_url: String,
    pub listen_addr: SocketAddr,
    /// The built frontend (`web/dist`), served on the same port as the API.
    pub web_dir: Option<PathBuf>,
    /// Where the passkey is saved. Setting it turns passkey sign-in on.
    pub passkey_file: Option<PathBuf>,
}

impl Config {
    /// Reads `DATABASE_URL`, `LISTEN_ADDR` (default 127.0.0.1:8080), `WEB_DIR` (default `web/dist`,
    /// skipped when it doesn't exist, e.g. during frontend development with the Vite dev server) and
    /// `PASSKEY_FILE` (unset: no sign-in).
    pub fn from_env() -> Result<Self> {
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?;
        let listen_addr = std::env::var("LISTEN_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".into())
            .parse()
            .context("LISTEN_ADDR is not a valid socket address")?;
        let web_dir = PathBuf::from(std::env::var("WEB_DIR").unwrap_or_else(|_| "web/dist".into()));
        let web_dir = web_dir.join("index.html").is_file().then_some(web_dir);
        let passkey_file = std::env::var_os("PASSKEY_FILE").filter(|p| !p.is_empty()).map(PathBuf::from);
        Ok(Self { database_url, listen_addr, web_dir, passkey_file })
    }
}
