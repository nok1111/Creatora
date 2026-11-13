//! TikTok video statistics — POST /v2/video/query/ returns per-video
//! counters. Requires `video.list` scope (app approval); a scope error
//! propagates as a real HttpError for the sync engine to record.

use super::StatsResult;
use crate::social::platforms::http::{ep, post_json, HttpError};

pub fn stats(token: &str, video_id: &str) -> Result<StatsResult, HttpError> {
    let body = post_json(
        &format!(
            "{}/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count",
            ep("tiktok.api", "https://open.tiktokapis.com")
        ),
        token,
        &serde_json::json!({"filters": {"video_ids": [video_id]}}),
    )?;
    // TikTok wraps errors INSIDE 200 bodies: error.code != "ok".
    let code = body["error"]["code"].as_str().unwrap_or("ok");
    if code != "ok" {
        let msg = body["error"]["message"].as_str().unwrap_or(code);
        return Err(HttpError {
            status: Some(200),
            message: format!("tiktok query error {code}: {msg}"),
            retry_after: None,
            body: Some(body),
        });
    }
    let mut out = StatsResult::default();
    let v = body["data"]["videos"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| HttpError {
            status: Some(200),
            message: format!("video {video_id} not in query response"),
            retry_after: None,
            body: Some(body.clone()),
        })?;
    let num = |k: &str| v[k].as_f64();
    if let Some(x) = num("view_count") {
        out.metrics
            .push(StatsResult::m("views", "Views", "count", x));
    }
    if let Some(x) = num("like_count") {
        out.metrics
            .push(StatsResult::m("likes", "Likes", "count", x));
    }
    if let Some(x) = num("comment_count") {
        out.metrics
            .push(StatsResult::m("comments", "Comments", "count", x));
    }
    if let Some(x) = num("share_count") {
        out.metrics
            .push(StatsResult::m("shares", "Shares", "count", x));
    }
    Ok(out)
}
