use serde::Serialize;
use thiserror::Error;

/// Serialized shape the frontend receives on any command failure.
/// `code` is a stable machine string; `message` is human-readable (EN —
/// localized presentation is the frontend's job via i18n).
/// Variants not yet constructed are kept — commands land in later phases.
#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("internal error: {0}")]
    Internal(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorPayload {
    pub code: String,
    pub message: String,
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::NotFound(_) => "not_found",
            AppError::InvalidInput(_) => "invalid_input",
            AppError::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        AppErrorPayload {
            code: self.code().to_string(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError::InvalidInput(e)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

pub type CmdResult<T> = Result<T, AppError>;
