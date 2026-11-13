//! Credential vault — OS-backed, never SQLite, never plaintext on disk.
//! Windows: Credential Manager (DPAPI under the hood) via `keyring`.
//! Each account's token bundle is a single JSON secret keyed by account id.

use crate::error::AppError;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "creatora.social";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBundle {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds when access_token dies (None = non-expiring).
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Platform extras — open_id, page token, ig user id…
    #[serde(default)]
    pub extra: serde_json::Value,
}

fn entry(account_id: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(SERVICE, account_id)
        .map_err(|e| AppError::Internal(format!("keyring: {e}")))
}

pub fn store_tokens(account_id: &str, tokens: &TokenBundle) -> Result<(), AppError> {
    let json = serde_json::to_string(tokens)
        .map_err(|e| AppError::Internal(format!("serialize tokens: {e}")))?;
    entry(account_id)?
        .set_password(&json)
        .map_err(|e| AppError::Internal(format!("vault store: {e}")))
}

pub fn load_tokens(account_id: &str) -> Result<TokenBundle, AppError> {
    let json = entry(account_id)?
        .get_password()
        .map_err(|e| AppError::NotFound(format!("credentials for {account_id}: {e}")))?;
    serde_json::from_str(&json).map_err(|e| AppError::Internal(format!("corrupt vault entry: {e}")))
}

pub fn delete_tokens(account_id: &str) -> Result<(), AppError> {
    entry(account_id)?
        .delete_credential()
        .map_err(|e| AppError::Internal(format!("vault delete: {e}")))
}

/// Same vault, different namespace: user-configured OAuth client secrets.
/// Client ids are public (fine in settings table); secrets are not.
pub fn store_client_secret(platform: &str, secret: &str) -> Result<(), AppError> {
    keyring::Entry::new("creatora.oauth_client", platform)
        .map_err(|e| AppError::Internal(format!("keyring: {e}")))?
        .set_password(secret)
        .map_err(|e| AppError::Internal(format!("vault store: {e}")))
}

pub fn load_client_secret(platform: &str) -> Result<String, AppError> {
    keyring::Entry::new("creatora.oauth_client", platform)
        .map_err(|e| AppError::Internal(format!("keyring: {e}")))?
        .get_password()
        .map_err(|e| AppError::NotFound(format!("client secret {platform}: {e}")))
}

pub fn is_expired(tokens: &TokenBundle, skew_secs: i64) -> bool {
    match tokens.expires_at {
        Some(t) => t <= super::validate::now_unix() + skew_secs,
        None => false,
    }
}
