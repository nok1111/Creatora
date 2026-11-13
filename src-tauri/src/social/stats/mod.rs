//! Platform statistics adapters (ADR-029).
//!
//! Each adapter returns *what its API actually returned* — canonical
//! metric keys when the semantic matches, plus an explicit
//! `unavailable` list with the reason (missing scope, wrong account
//! type, endpoint doesn't exist). Nothing is estimated, synthesized
//! or renamed to look comparable when it isn't.
//!
//! Canonical keys (only when semantics match across platforms):
//!   views, impressions, reach, likes, comments, shares, saves,
//!   watch_time_minutes, avg_view_duration_sec, followers_gained.
//! Platform-unique metrics keep a prefixed key (e.g. `tt_play_time`).

pub mod facebook;
pub mod instagram;
pub mod tiktok;
pub mod youtube;

use super::platforms::http::HttpError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    /// Canonical key ("views") or platform-prefixed ("fb_post_clicks").
    pub key: String,
    /// Human label from the provider's own docs.
    pub label: String,
    /// "count" | "seconds" | "minutes" | "ratio" | "percent".
    pub unit: String,
    pub value: f64,
}

/// A metric the user asked about that the API could NOT serve.
/// `reason` is displayed verbatim — scope missing, account type,
/// metric retired, etc.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unavailable {
    pub key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatsResult {
    pub metrics: Vec<Metric>,
    pub unavailable: Vec<Unavailable>,
}

impl StatsResult {
    pub fn m(key: &str, label: &str, unit: &str, value: f64) -> Metric {
        Metric {
            key: key.into(),
            label: label.into(),
            unit: unit.into(),
            value,
        }
    }
    pub fn un(key: &str, reason: impl Into<String>) -> Unavailable {
        Unavailable {
            key: key.into(),
            reason: reason.into(),
        }
    }
}

/// Fetch lifetime stats for one remote post. `platform_post_id` must be
/// the id the platform API itself returned — never a guess.
pub fn fetch_stats(
    platform: &str,
    token: &str,
    remote_id: &str,
    meta: &serde_json::Value,
) -> Result<StatsResult, HttpError> {
    match platform {
        "youtube" => youtube::stats(token, remote_id),
        "tiktok" => tiktok::stats(token, remote_id),
        "instagram" => instagram::stats(token, remote_id),
        "facebook" => facebook::stats(token, remote_id, meta),
        _ => Err(HttpError {
            status: None,
            message: format!("no stats adapter for {platform}"),
            retry_after: None,
            body: None,
        }),
    }
}

/// Which stats surfaces an adapter exposes — used by the UI to explain
/// capability without calling the API.
pub fn stats_capability(platform: &str) -> &'static str {
    match platform {
        "youtube" => "videos.list statistics (views/likes/comments) via youtube.readonly. Watch-time/impressions via YouTube Analytics API — needs yt-analytics.readonly scope (channel owner only).",
        "tiktok" => "video/query per-video counts (likes/comments/shares/views) — needs video.list scope approval.",
        "instagram" => "/{media}/insights (reach/likes/comments/saved/shares) — Business/Creator accounts + instagram_manage_insights.",
        "facebook" => "/{post}/insights + video_insights — needs read_insights + Page role; metric availability varies by Page.",
        _ => "unsupported",
    }
}
