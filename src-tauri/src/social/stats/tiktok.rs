//! TikTok video statistics — POST /v2/video/query/ returns per-video
//! counters. Requires `video.list` scope (app approval); a scope error
//! propagates as a real HttpError for the sync engine to record.

use super::StatsResult;
use crate::social::platforms::http::{ep, get_json, post_json, HttpError};

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

/// Account-level: user/info → follower_count etc.
/// (scope user.info.basic — granted apps only; a scope error surfaces
/// as HttpError and is recorded, not faked).
pub fn account_stats(token: &str) -> Result<StatsResult, HttpError> {
    let body = get_json(
        &format!(
            "{}/v2/user/info/?fields=follower_count,following_count,likes_count,video_count",
            ep("tiktok.api", "https://open.tiktokapis.com")
        ),
        token,
    )?;
    let mut out = StatsResult::default();
    let u = &body["data"]["user"];
    let num = |k: &str| u[k].as_f64();
    match num("follower_count") {
        Some(v) => {
            out.metrics
                .push(StatsResult::m("followers", "Followers", "count", v));
            if let Some(v) = num("following_count") {
                out.metrics
                    .push(StatsResult::m("tt_following", "Following", "count", v));
            }
            if let Some(v) = num("likes_count") {
                out.metrics
                    .push(StatsResult::m("tt_total_likes", "Total likes", "count", v));
            }
            if let Some(v) = num("video_count") {
                out.metrics
                    .push(StatsResult::m("tt_video_count", "Videos", "count", v));
            }
        }
        None => out.unavailable.push(StatsResult::un(
            "followers",
            "user.info returned no user — needs user.info.basic scope",
        )),
    }
    Ok(out)
}
