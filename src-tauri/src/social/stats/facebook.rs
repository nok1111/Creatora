//! Facebook Page post/video insights — GET /{id}/insights.
//! Needs read_insights + a Page role. Metric names come straight from
//! the Graph docs; availability genuinely varies by page/post type —
//! metrics the API didn't serve are listed in `unavailable`.

use super::StatsResult;
use crate::social::platforms::http::{ep, get_json, HttpError};

const WANTED: &[(&str, &str, &str)] = &[
    ("post_impressions", "impressions", "Impressions"),
    (
        "post_impressions_unique",
        "reach",
        "Reach (unique impressions)",
    ),
    ("post_reactions_like_total", "likes", "Reactions"),
    ("post_comments", "comments", "Comments"),
    ("post_video_views", "views", "Video views"),
    (
        "post_video_avg_time_watched",
        "avg_view_duration_sec",
        "Avg time watched",
    ),
];

pub fn stats(
    token: &str,
    remote_id: &str,
    _meta: &serde_json::Value,
) -> Result<StatsResult, HttpError> {
    let metrics: Vec<&str> = WANTED.iter().map(|(a, _, _)| *a).collect();
    let body = get_json(
        &format!(
            "{}/{remote_id}/insights?metric={}",
            ep("fb.graph", "https://graph.facebook.com/v21.0"),
            metrics.join(",")
        ),
        token,
    )?;
    let mut out = StatsResult::default();
    let mut served = std::collections::HashSet::new();
    for item in body["data"].as_array().into_iter().flatten() {
        let name = item["name"].as_str().unwrap_or("");
        let Some((api_name, key, label)) = WANTED.iter().find(|(a, _, _)| *a == name) else {
            continue;
        };
        served.insert(api_name.to_string());
        let val = item["values"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v["value"].as_f64());
        if let Some(v) = val {
            let unit = if *key == "avg_view_duration_sec" {
                "seconds"
            } else {
                "count"
            };
            out.metrics.push(StatsResult::m(key, label, unit, v));
        }
    }
    for (api_name, key, _) in WANTED {
        if !served.contains(*api_name) {
            out.unavailable.push(StatsResult::un(
                key,
                format!("{api_name} not returned — may not apply to this post type"),
            ));
        }
    }
    Ok(out)
}

/// Account-level: /{page-id}?fields=followers_count,fan_count —
/// Page followers. platform_user_id is the Page id stored at connect.
pub fn account_stats(token: &str, platform_user_id: &str) -> Result<StatsResult, HttpError> {
    let body = get_json(
        &format!(
            "{}/{platform_user_id}?fields=followers_count,fan_count",
            ep("fb.graph", "https://graph.facebook.com/v21.0")
        ),
        token,
    )?;
    let mut out = StatsResult::default();
    let v = body["followers_count"]
        .as_f64()
        .or_else(|| body["fan_count"].as_f64());
    match v {
        Some(v) => out
            .metrics
            .push(StatsResult::m("followers", "Page followers", "count", v)),
        None => out.unavailable.push(StatsResult::un(
            "followers",
            "no followers_count/fan_count — needs pages_read_engagement + Page role",
        )),
    }
    Ok(out)
}
