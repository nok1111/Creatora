//! YouTube statistics — two real surfaces:
//! 1. videos.list?part=statistics → views/likes/comments
//!    (scope: youtube.readonly — already granted at connect).
//! 2. YouTube Analytics API reports.query → estimatedMinutesWatched,
//!    averageViewDuration, impressions, impressionsCtr
//!    (scope: yt-analytics.readonly — channel owner only; a 403 is
//!    reported as `unavailable`, not an error).

use super::{StatsResult, Unavailable};
use crate::social::platforms::http::{ep, get_json, HttpError};

fn api() -> String {
    ep("youtube.api", "https://www.googleapis.com")
}

pub fn stats(token: &str, video_id: &str) -> Result<StatsResult, HttpError> {
    let mut out = StatsResult::default();

    let body = get_json(
        &format!("{}/youtube/v3/videos?part=statistics&id={video_id}", api()),
        token,
    )?;
    let item = body["items"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| HttpError {
            status: Some(200),
            message: format!("video {video_id} not found / not accessible"),
            retry_after: None,
            body: Some(body.clone()),
        })?;
    let s = &item["statistics"];
    let num = |k: &str| s[k].as_str().and_then(|v| v.parse::<f64>().ok());
    if let Some(v) = num("viewCount") {
        out.metrics
            .push(StatsResult::m("views", "Views", "count", v));
    }
    if let Some(v) = num("likeCount") {
        out.metrics
            .push(StatsResult::m("likes", "Likes", "count", v));
    }
    if let Some(v) = num("commentCount") {
        out.metrics
            .push(StatsResult::m("comments", "Comments", "count", v));
    }

    // Analytics API — separate surface, separate scope. Missing scope →
    // honest `unavailable`, never a failed sync.
    let analytics_url = format!(
        "{}/youtube/analytics/v2/reports\
         ?ids=channel==MINE&metrics=estimatedMinutesWatched,averageViewDuration,impressions,impressionsClickThroughRate\
         &filters=video=={video_id}",
        ep("youtube.analytics", "https://youtubeanalytics.googleapis.com")
    );
    match get_json(&analytics_url, token) {
        Ok(rep) => {
            if let (Some(cols), Some(row)) = (
                rep["columnHeaders"].as_array(),
                rep["rows"].as_array().and_then(|r| r.first()),
            ) {
                for (i, col) in cols.iter().enumerate() {
                    let name = col["name"].as_str().unwrap_or("");
                    let v = row
                        .as_array()
                        .and_then(|r| r.get(i))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let (key, unit, label) = match name {
                        "estimatedMinutesWatched" => {
                            ("watch_time_minutes", "minutes", "Watch time")
                        }
                        "averageViewDuration" => {
                            ("avg_view_duration_sec", "seconds", "Avg view duration")
                        }
                        "impressions" => ("impressions", "count", "Impressions"),
                        "impressionsClickThroughRate" => {
                            ("yt_impressions_ctr", "percent", "Impressions CTR")
                        }
                        _ => continue,
                    };
                    out.metrics.push(StatsResult::m(key, label, unit, v));
                }
            }
        }
        Err(e) if e.is_forbidden() || e.is_unauthorized() => {
            for (k, l) in [
                ("watch_time_minutes", "Watch time"),
                ("avg_view_duration_sec", "Avg view duration"),
                ("impressions", "Impressions"),
            ] {
                let _ = l;
                out.unavailable.push(Unavailable {
                    key: k.into(),
                    reason: "requires yt-analytics.readonly scope + channel ownership".into(),
                });
            }
        }
        Err(e) => return Err(e),
    }
    Ok(out)
}

/// Account-level: channels.list?part=statistics&mine=true →
/// subscriberCount / viewCount / videoCount for the authenticated
/// channel (scope youtube.readonly — already granted).
pub fn account_stats(token: &str) -> Result<StatsResult, HttpError> {
    let body = get_json(
        &format!("{}/youtube/v3/channels?part=statistics&mine=true", api()),
        token,
    )?;
    let mut out = StatsResult::default();
    let item = body["items"].as_array().and_then(|a| a.first());
    match item {
        Some(ch) => {
            let s = &ch["statistics"];
            let num = |k: &str| s[k].as_str().and_then(|v| v.parse::<f64>().ok());
            if let Some(v) = num("subscriberCount") {
                out.metrics
                    .push(StatsResult::m("followers", "Subscribers", "count", v));
            }
            if let Some(v) = num("viewCount") {
                out.metrics.push(StatsResult::m(
                    "yt_channel_views",
                    "Channel total views",
                    "count",
                    v,
                ));
            }
            if let Some(v) = num("videoCount") {
                out.metrics.push(StatsResult::m(
                    "yt_channel_videos",
                    "Channel videos",
                    "count",
                    v,
                ));
            }
        }
        None => out.unavailable.push(StatsResult::un(
            "followers",
            "channels.list returned no channel for this account",
        )),
    }
    Ok(out)
}
