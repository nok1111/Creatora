//! DTOs shared by commands, validation and adapters (mirror in
//! src/lib/social-types.ts).

use serde::{Deserialize, Serialize};

pub const PLATFORMS: [&str; 4] = ["youtube", "tiktok", "instagram", "facebook"];

pub const POST_STATUSES: [&str; 6] = [
    "draft",
    "ready",
    "scheduled",
    "publishing",
    "published",
    "failed",
];

pub const TARGET_STATUSES: [&str; 7] = [
    "draft",
    "ready",
    "scheduled",
    "publishing",
    "published",
    "failed",
    "cancelled",
];

/// A post is the shared envelope; targets carry the per-platform payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPost {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub caption: String,
    pub hashtags: Vec<String>,
    pub thumbnail_asset_id: Option<String>,
    pub notes: Option<String>,
    /// Aggregate state (worst of targets wins: failed > draft > …).
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub targets: Vec<SocialPostTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialPostTarget {
    pub id: String,
    pub post_id: String,
    pub platform: String,
    pub account_id: Option<String>,
    /// FormatVersion to export for this platform (NULL = base canvas).
    pub version_id: Option<String>,
    /// media_assets row of the exported file — links post ↔ real file.
    pub export_asset_id: Option<String>,
    /// Per-platform overrides; NULL = inherit post fields.
    pub title: Option<String>,
    pub caption: Option<String>,
    pub hashtags: Option<Vec<String>>,
    /// Platform-specific options: privacy, page_id, selfDeclaredMadeForKids…
    pub platform_meta: serde_json::Value,
    pub status: String,
    /// Local scheduling time (ISO-8601 local or RFC3339 UTC).
    pub scheduled_at: Option<String>,
    /// 1 = attempt real upload when due; 0 = reminder only.
    pub auto_publish: bool,
    pub platform_post_id: Option<String>,
    pub platform_url: Option<String>,
    pub last_error: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialAccount {
    pub id: String,
    pub platform: String,
    pub platform_user_id: String,
    pub display_name: Option<String>,
    pub scopes: Vec<String>,
    /// active | expired | revoked | error — reflects vault/API truth.
    pub status: String,
    pub connected_at: String,
    pub token_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTemplate {
    pub id: String,
    pub name: String,
    pub body: String,
    pub hashtags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationAttempt {
    pub id: String,
    pub target_id: String,
    pub status: String,
    pub platform_post_id: Option<String>,
    pub platform_url: Option<String>,
    pub error: Option<String>,
    pub attempt_no: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Validation finding — actionable, not just a complaint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// error | warning | recommendation | info | passed
    pub severity: String,
    /// Stable machine code (i18n keys on the frontend).
    pub code: String,
    pub message: String,
    /// What to do about it — human text + machine action for the fix button.
    pub fix: Option<String>,
    /// openFormats | openCaptions | pickFile | connectAccount | none
    #[serde(default)]
    pub fix_action: String,
    /// Interpolation values for the frontend's translated message
    /// (`message` stays the English fallback).
    #[serde(default)]
    pub params: serde_json::Value,
}

/// What a platform can really do — surfaced in UI so nothing is implied.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapability {
    pub platform: String,
    pub oauth: bool,
    pub publish: bool,
    pub requires_app_review: bool,
    pub requires_hosted_media: bool,
    pub status_note: String,
    /// An official app credential is shipped — users can Connect without
    /// configuring their own developer app.
    #[serde(default)]
    pub official_client: bool,
}

pub fn valid_platform(p: &str) -> bool {
    PLATFORMS.contains(&p)
}

/// Post status is derived from its targets — never stored inconsistently.
/// failed > publishing > scheduled > ready > draft > published.
/// published only when EVERY target is published/cancelled.
pub fn aggregate_status(targets: &[SocialPostTarget]) -> &'static str {
    if targets.is_empty() {
        return "draft";
    }
    if targets.iter().any(|t| t.status == "failed") {
        return "failed";
    }
    if targets.iter().any(|t| t.status == "publishing") {
        return "publishing";
    }
    if targets.iter().any(|t| t.status == "scheduled") {
        return "scheduled";
    }
    if targets
        .iter()
        .all(|t| t.status == "published" || t.status == "cancelled")
    {
        return "published";
    }
    if targets.iter().any(|t| t.status == "ready") {
        return "ready";
    }
    "draft"
}

/// Hashtag helpers — normalize "#tag", dedupe case-insensitive.
pub fn normalize_hashtag(tag: &str) -> String {
    let t = tag.trim().trim_start_matches('#');
    t.split_whitespace().next().unwrap_or("").to_string()
}

pub fn dedupe_hashtags(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for t in tags {
        let n = normalize_hashtag(t);
        if !n.is_empty() && seen.insert(n.to_lowercase()) {
            out.push(n);
        }
    }
    out
}

/// Pull hashtags embedded in caption text (#word) — for the counter.
pub fn extract_hashtags(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|w| w.starts_with('#') && w.len() > 1)
        .map(|w| {
            w.trim_matches(|c: char| !(c.is_alphanumeric() || c == '_'))
                .to_string()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashtags_normalize_and_dedupe() {
        let d = dedupe_hashtags(&[
            "#Travel".into(),
            "travel".into(),
            "  #Food ".into(),
            "".into(),
            "#a b".into(),
        ]);
        assert_eq!(d, vec!["Travel", "Food", "a"]);
    }

    #[test]
    fn extract_from_caption() {
        let h = extract_hashtags("hello #world and #rust-lang, #ok!");
        assert_eq!(h, vec!["world", "rust-lang", "ok"]);
    }

    fn t(status: &str) -> SocialPostTarget {
        SocialPostTarget {
            id: "t".into(),
            post_id: "p".into(),
            platform: "youtube".into(),
            account_id: None,
            version_id: None,
            export_asset_id: None,
            title: None,
            caption: None,
            hashtags: None,
            platform_meta: serde_json::json!({}),
            status: status.into(),
            scheduled_at: None,
            auto_publish: false,
            platform_post_id: None,
            platform_url: None,
            last_error: None,
            published_at: None,
        }
    }

    #[test]
    fn aggregate_prefers_failure_and_never_marks_published_early() {
        assert_eq!(aggregate_status(&[]), "draft");
        assert_eq!(aggregate_status(&[t("ready"), t("failed")]), "failed");
        assert_eq!(
            aggregate_status(&[t("published"), t("published")]),
            "published"
        );
        assert_eq!(aggregate_status(&[t("published"), t("draft")]), "draft");
        assert_eq!(aggregate_status(&[t("scheduled"), t("ready")]), "scheduled");
    }
}
