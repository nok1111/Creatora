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
