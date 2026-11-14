//! Instagram media insights — GET /{media-id}/insights.
//! Hard requirements (surfaced as errors, not hidden):
//!   Business/Creator account + instagram_manage_insights scope.
//! Metric set follows the current Graph docs: reach, likes, comments,
//! saved, shares, total_interactions (reels: also plays).

use super::StatsResult;
use crate::social::platforms::http::{ep, get_json, HttpError};

const WANTED: &[(&str, &str, &str)] = &[
    ("reach", "reach", "Reach"),
    ("likes", "likes", "Likes"),
    ("comments", "comments", "Comments"),
    ("saved", "saves", "Saves"),
    ("shares", "shares", "Shares"),
    (
        "total_interactions",
        "ig_total_interactions",
        "Total interactions",
    ),
    ("plays", "views", "Plays"),
];

pub fn stats(token: &str, media_id: &str) -> Result<StatsResult, HttpError> {
    let metrics: Vec<&str> = WANTED.iter().map(|(a, _, _)| *a).collect();
    let body = get_json(
        &format!(
            "{}/{media_id}/insights?metric={}",
            ep("fb.graph", "https://graph.facebook.com/v21.0"),
            metrics.join(",")
        ),
        token,
    )?;
    let mut out = StatsResult::default();
    let mut seen = std::collections::HashSet::new();
    for item in body["data"].as_array().into_iter().flatten() {
        let name = item["name"].as_str().unwrap_or("");
        let Some((_, key, label)) = WANTED.iter().find(|(a, _, _)| *a == name) else {
            continue;
        };
        let val = item["values"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v["value"].as_f64());
        if let Some(v) = val {
            if seen.insert(key.to_string()) {
                out.metrics.push(StatsResult::m(key, label, "count", v));
            }
        }
    }
    Ok(out)
}

/// Account-level: /{ig-user-id}?fields=followers_count,media_count —
/// professional accounts only; platform_user_id is the IG user id
/// stored at connect (meta.igUserId wins when present).
pub fn account_stats(
    token: &str,
    platform_user_id: &str,
    meta: &serde_json::Value,
) -> Result<StatsResult, HttpError> {
    let uid = meta
        .get("igUserId")
        .and_then(|v| v.as_str())
        .unwrap_or(platform_user_id);
    let body = get_json(
        &format!(
            "{}/{uid}?fields=followers_count,media_count",
            ep("fb.graph", "https://graph.facebook.com/v21.0")
        ),
        token,
    )?;
    let mut out = StatsResult::default();
    match body["followers_count"].as_f64() {
        Some(v) => {
            out.metrics
                .push(StatsResult::m("followers", "Followers", "count", v));
            if let Some(v) = body["media_count"].as_f64() {
                out.metrics
                    .push(StatsResult::m("ig_media_count", "Media", "count", v));
            }
        }
        None => out.unavailable.push(StatsResult::un(
            "followers",
            "no followers_count — needs a Business/Creator IG user id",
        )),
    }
    Ok(out)
}
