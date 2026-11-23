//! gRPC handlers. They only convert proto <-> core types and core errors <-> Status;
//! all logic lives in `tally-core`.

mod accounts;
mod categories;
mod imports;
mod links;
mod reports;
mod rules;
mod transactions;

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use axum::http::{HeaderValue, header};
use tally_core::{Error, Ledger};
use tonic::Status;
use tonic::service::Routes;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;

pub mod pb {
    tonic::include_proto!("finance");
}

/// Serves the API on `addr` until `shutdown` resolves: native gRPC, gRPC-web for the browser, and
/// the built frontend from `web_dir` for every other path (unknown paths get index.html, so the
/// frontend's own routes work on reload). Same origin, so no CORS.
pub async fn serve(
    ledger: Ledger,
    addr: SocketAddr,
    web_dir: Option<PathBuf>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    let mut routes = Routes::builder();
    routes
        .add_service(pb::account_service_server::AccountServiceServer::new(accounts::Svc(ledger.clone())))
        .add_service(pb::category_service_server::CategoryServiceServer::new(categories::Svc(ledger.clone())))
        .add_service(pb::import_service_server::ImportServiceServer::new(imports::Svc(ledger.clone())))
        .add_service(pb::link_service_server::LinkServiceServer::new(links::Svc(ledger.clone())))
        .add_service(pb::report_service_server::ReportServiceServer::new(reports::Svc(ledger.clone())))
        .add_service(pb::rule_service_server::RuleServiceServer::new(rules::Svc(ledger.clone())))
        .add_service(pb::transaction_service_server::TransactionServiceServer::new(transactions::Svc(ledger)));

    // The gRPC-web layer rejects plain HTTP/1 requests, so it wraps only the gRPC routes: axum applies
    // a layer to what exists when `.layer()` is called, and the static files are added after it.
    let mut app = routes.routes().into_axum_router().layer(tonic_web::GrpcWebLayer::new());
    if let Some(dir) = web_dir {
        // Always revalidate (the files carry ETag / Last-Modified, so this is a cheap 304), so a
        // reload after a new build never runs a stale index.html.
        let files = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
        app = app.fallback_service(SetResponseHeader::overriding(
            files,
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ));
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    Ok(())
}

pub(crate) fn status(err: Error) -> Status {
    match err {
        Error::NotFound(msg) => Status::not_found(msg),
        Error::InvalidArgument(msg) => Status::invalid_argument(msg),
        Error::FailedPrecondition(msg) => Status::failed_precondition(msg),
        Error::Database(e) => {
            tracing::error!(error = %e, "database error");
            Status::internal("internal error")
        }
    }
}

pub(crate) fn timestamp(t: jiff::Timestamp) -> prost_types::Timestamp {
    prost_types::Timestamp { seconds: t.as_second(), nanos: t.subsec_nanosecond() }
}

pub(crate) fn date_to_pb(d: jiff::civil::Date) -> pb::Date {
    pb::Date { year: d.year().into(), month: d.month().into(), day: d.day().into() }
}

pub(crate) fn date_from_pb(d: &pb::Date, field: &str) -> Result<jiff::civil::Date, Status> {
    let invalid = || Status::invalid_argument(format!("{field} is not a valid date"));
    let year = i16::try_from(d.year).map_err(|_| invalid())?;
    let month = i8::try_from(d.month).map_err(|_| invalid())?;
    let day = i8::try_from(d.day).map_err(|_| invalid())?;
    jiff::civil::Date::new(year, month, day).map_err(|_| invalid())
}

pub(crate) fn required_date(d: Option<&pb::Date>, field: &str) -> Result<jiff::civil::Date, Status> {
    date_from_pb(d.ok_or_else(|| Status::invalid_argument(format!("{field} is required")))?, field)
}
