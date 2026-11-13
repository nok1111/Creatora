//! Typed HTTP layer for platform adapters (ADR-029).
//!
//! Every response — including 4xx/5xx — is read so provider error bodies
//! (e.g. `{"error":{"message":…}}`) survive into the attempt log and the
//! sync engine can classify: 401 → refresh, 429 → Retry-After backoff,
//! 5xx → retryable, everything else → terminal.
//!
//! `ep()` indirection exists so tests can point adapters at a local
//! mock server without touching production endpoints.

use std::sync::Mutex;

/// A platform call failed. `status` is None for network/timeout/protocol
/// failures (no HTTP response was received).
#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: Option<u16>,
    /// Human-readable: provider `error.message` when present, else the
    /// transport error. Never contains the Authorization header/token.
    pub message: String,
    /// Seconds from the Retry-After header, when the server sent it.
    pub retry_after: Option<u64>,
    /// Parsed provider body, when it was JSON — adapters may pull extra
    /// fields (TikTok error.code, Meta error.subcode…).
    pub body: Option<serde_json::Value>,
}

impl HttpError {
    pub fn is_unauthorized(&self) -> bool {
        self.status == Some(401)
    }
    pub fn is_forbidden(&self) -> bool {
        self.status == Some(403)
    }
    pub fn is_rate_limited(&self) -> bool {
        self.status == Some(429)
    }
    /// Worth retrying later (rate limit, server error, transport drop).
    pub fn is_retryable(&self) -> bool {
        self.status.is_none() || matches!(self.status, Some(429) | Some(500..=599))
    }
    pub fn to_message(&self) -> String {
        match self.status {
            Some(s) => format!("HTTP {s}: {}", self.message),
            None => format!("network: {}", self.message),
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_message())
    }
}
impl std::error::Error for HttpError {}

// -- endpoint overrides (test hook) ----------------------------------------

static EP_OVERRIDES: Mutex<Vec<(&'static str, String)>> = Mutex::new(Vec::new());

/// Resolve an endpoint. Tests override by key; production always hits
/// `default`.
pub fn ep(key: &'static str, default: &str) -> String {
    EP_OVERRIDES
        .lock()
        .ok()
        .and_then(|m| m.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone()))
        .unwrap_or_else(|| default.to_string())
}

#[doc(hidden)]
pub fn set_endpoint_override(key: &'static str, url: &str) {
    if let Ok(mut m) = EP_OVERRIDES.lock() {
        m.retain(|(k, _)| *k != key);
        m.push((key, url.to_string()));
    }
}

#[doc(hidden)]
pub fn clear_endpoint_overrides() {
    if let Ok(mut m) = EP_OVERRIDES.lock() {
        m.clear();
    }
}

// -- calls ------------------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .build()
        .into()
}

fn run(
    req: ureq::RequestBuilder<ureq::typestate::WithoutBody>,
    label: &str,
) -> Result<serde_json::Value, HttpError> {
    // status-as-error disabled so 4xx/5xx bodies stay readable.
    finish(
        req.config().http_status_as_error(false).build().call(),
        label,
    )
}

fn finish(
    r: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    label: &str,
) -> Result<serde_json::Value, HttpError> {
    let mut resp = match r {
        Ok(resp) => resp,
        Err(ureq::Error::StatusCode(s)) => {
            // Only reachable if a caller forgot http_status_as_error(false).
            return Err(HttpError {
                status: Some(s),
                message: label.into(),
                retry_after: None,
                body: None,
            });
        }
        Err(e) => {
            return Err(HttpError {
                status: None,
                message: format!("{label}: {e}"),
                retry_after: None,
                body: None,
            })
        }
    };
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let text = resp.body_mut().read_to_string().map_err(|e| HttpError {
        status: Some(status),
        message: format!("body read: {e}"),
        retry_after,
        body: None,
    })?;
    let body: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::Value::String(text.clone()));
    if !(200..300).contains(&status) {
        return Err(HttpError {
            status: Some(status),
            message: super::api_err(&body).unwrap_or_else(|| truncate(&text, 300)),
            retry_after,
            body: Some(body),
        });
    }
    if let serde_json::Value::String(raw) = &body {
        // Non-JSON success body — surfaces as an adapter-level error,
        // not a crash.
        return Err(HttpError {
            status: Some(status),
            message: format!("expected JSON, got {}", truncate(raw, 80)),
            retry_after,
            body: Some(body),
        });
    }
    Ok(body)
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

/// GET JSON with bearer token.
pub fn get_json(url: &str, token: &str) -> Result<serde_json::Value, HttpError> {
    run(
        agent()
            .get(url)
            .header("Authorization", format!("Bearer {token}")),
        "GET",
    )
}

/// POST JSON with bearer token.
pub fn post_json(
    url: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, HttpError> {
    let resp = agent()
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .config()
        .http_status_as_error(false)
        .build()
        .send_json(body);
    finish(resp, "POST")
}
