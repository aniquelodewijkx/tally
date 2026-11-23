use sea_orm::{DbErr, SqlErr};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} not found")]
    NotFound(String),
    #[error("{0}")]
    InvalidArgument(String),
    /// The request is valid, but the current state doesn't allow it (a group rule, a row in use).
    #[error("{0}")]
    FailedPrecondition(String),
    #[error("database error: {0}")]
    Database(DbErr),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        match err.sql_err() {
            Some(SqlErr::UniqueConstraintViolation(msg)) => Error::FailedPrecondition(format!("already exists: {msg}")),
            Some(SqlErr::ForeignKeyConstraintViolation(msg)) => {
                Error::FailedPrecondition(format!("still in use: {msg}"))
            }
            _ => Error::Database(err),
        }
    }
}

impl From<sources::SourceError> for Error {
    fn from(err: sources::SourceError) -> Self {
        Error::InvalidArgument(err.to_string())
    }
}

pub(crate) fn not_found(what: &str, id: i64) -> Error {
    Error::NotFound(format!("{what} #{id}"))
}
