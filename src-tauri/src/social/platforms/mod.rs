//! Per-platform API adapters — each owns its real HTTP surface. Nothing
//! fakes success: a platform only reports `published` when its API
//! returned a concrete post id / URL. Capability metadata lives in
//! rules.rs so limitations travel with the ruleset, not the UI.

pub mod facebook;
pub mod http;
pub mod instagram;
#[cfg(test)]
mod mock_tests;
pub mod tiktok;
pub mod youtube;

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct PublishInput {
    /// Local exported file. Required for file-upload platforms
    /// (YouTube/TikTok/Facebook); ignored by Instagram (hosted URL only).
    pub file_path: Option<PathBuf>,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    /// platform_meta_json — privacy, page_id, madeForKids, draft mode…
    pub meta: serde_json::Value,
    /// Publicly reachable media URL (Instagram requirement).
    pub hosted_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcome {
    pub platform_post_id: Option<String>,
    pub url: Option<String>,
    /// Raw API response for the attempt log.
    pub raw: serde_json::Value,
}

/// Progress callback: (bytes_sent, total_bytes). `'a` — callers' closures
/// may borrow job context; trait objects are not forced 'static.
pub type Progress<'a> = dyn Fn(u64, u64) + Send + Sync + 'a;
/// Cancel check — true = abort upload.
pub type Cancelled<'a> = dyn Fn() -> bool + Send + Sync + 'a;

/// Fetch the authenticated user's platform identity for the account row.
/// Called once after OAuth; failure is non-fatal (uid falls back).
pub fn fetch_identity(
    platform: &str,
    access_token: &str,
    _token_body: &serde_json::Value,
) -> Result<(String, Option<String>), String> {
    match platform {
        "youtube" => youtube::identity(access_token),
        "tiktok" => tiktok::identity(access_token),
        "instagram" => instagram::identity(access_token),
        "facebook" => facebook::identity(access_token),
        _ => Err(format!("no identity adapter for {platform}")),
    }
}

/// Publish to a platform. Errors are strings destined for the attempt
/// log + UI — they must say what the API actually did.
pub fn publish(
    platform: &str,
    access_token: &str,
    input: &PublishInput,
    progress: &Progress<'_>,
    cancelled: &Cancelled<'_>,
) -> Result<PublishOutcome, String> {
    if cancelled() {
        return Err("cancelled".into());
    }
    match platform {
        "youtube" => youtube::publish(access_token, input, progress, cancelled),
        "tiktok" => tiktok::publish(access_token, input, progress, cancelled),
        "instagram" => instagram::publish(access_token, input, progress, cancelled),
        "facebook" => facebook::publish(access_token, input, progress, cancelled),
        _ => Err(format!("no publish adapter for {platform}")),
    }
}

/// Pull `error.message` out of a provider body, if any.
pub fn api_err(body: &serde_json::Value) -> Option<String> {
    body.get("error")
        .and_then(|e| {
            e.get("message")
                .or_else(|| e.get("code"))
                .map(|m| m.to_string())
        })
        .or_else(|| body.get("message").map(|m| m.to_string()))
}

pub fn require_file(input: &PublishInput) -> Result<&std::path::Path, String> {
    let p = input
        .file_path
        .as_deref()
        .ok_or("no export file linked — export for this platform first")?;
    if !p.exists() {
        return Err(format!("export file missing: {}", p.display()));
    }
    Ok(p)
}

pub fn meta_str<'a>(input: &'a PublishInput, key: &str) -> Option<&'a str> {
    input.meta.get(key).and_then(|v| v.as_str())
}

pub fn meta_bool(input: &PublishInput, key: &str) -> bool {
    input
        .meta
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}
