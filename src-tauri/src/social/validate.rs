//! Pre-flight validation: compares a target's actual export (probed file)
//! or planned version (project canvas) against the platform ruleset.
//! Every finding carries a fix + a machine action the UI can jump to.

use super::model::{extract_hashtags, Finding, SocialPost, SocialPostTarget};
use super::rules::PlatformRules;
use crate::error::{AppError, CmdResult};
use serde_json::json;

/// Facts about what will actually be published — from the exported file
/// (probed) when present, else from the project's version canvas.
#[derive(Debug, Clone, Default)]
pub struct MediaFacts {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<i64>,
    pub bytes: Option<i64>,
    pub has_audio: Option<bool>,
    pub codec: Option<String>,
    pub container: Option<String>,
    pub file_exists: bool,
}

fn f(sev: &str, code: &str, msg: impl Into<String>, fix: Option<&str>, action: &str) -> Finding {
    Finding {
        severity: sev.into(),
        code: code.into(),
        message: msg.into(),
        fix: fix.map(str::to_string),
        fix_action: action.into(),
        params: serde_json::Value::Null,
    }
}

impl Finding {
    fn with(mut self, params: serde_json::Value) -> Self {
        self.params = params;
        self
    }
}

/// Validate one target. `account_connected` = a live account row exists.
pub fn validate_target(
    rules: &PlatformRules,
    post: &SocialPost,
    target: &SocialPostTarget,
    media: &MediaFacts,
    account_connected: bool,
    rules_updated: &str,
) -> Vec<Finding> {
    let mut out = Vec::new();
    let meta = &rules.metadata;
    let vid = &rules.video;
    let title = target.title.clone().unwrap_or_else(|| post.title.clone());
    let caption = target
        .caption
        .clone()
        .unwrap_or_else(|| post.caption.clone());
    let tags = target
        .hashtags
        .clone()
        .unwrap_or_else(|| post.hashtags.clone());

    // --- metadata ---
    if meta.title_required && title.trim().is_empty() {
        out.push(
            f(
                "error",
                "title_empty",
                format!("{} requires a title", rules.display_name),
                Some("Add a title in Caption Studio"),
                "openCaptions",
            )
            .with(json!({"platform": rules.display_name})),
        );
    }
    if meta.title_max_chars > 0 && title.chars().count() > meta.title_max_chars {
        out.push(f(
            "error",
            "title_too_long",
            format!(
                "Title is {} chars — {} caps at {}",
                title.chars().count(),
                rules.display_name,
                meta.title_max_chars
            ),
            Some("Shorten the title"),
            "openCaptions",
        ).with(json!({"n": title.chars().count(), "platform": rules.display_name, "max": meta.title_max_chars})));
    }
    if meta.caption_max_chars > 0 && caption.chars().count() > meta.caption_max_chars {
        out.push(
            f(
                "error",
                "caption_too_long",
                format!(
                    "Caption exceeds {} chars on {}",
                    meta.caption_max_chars, rules.display_name
                ),
                Some("Trim the caption"),
                "openCaptions",
            )
            .with(json!({"platform": rules.display_name, "max": meta.caption_max_chars})),
        );
    }
    let all_tags: Vec<String> = tags
        .iter()
        .cloned()
        .chain(extract_hashtags(&caption))
        .collect();
    if meta.hashtag_max > 0 && all_tags.len() > meta.hashtag_max {
        out.push(f(
            "warning",
            "hashtags_over",
            format!(
                "{} hashtags — {} caps at {} (extras are ignored)",
                all_tags.len(),
                rules.display_name,
                meta.hashtag_max
            ),
            Some("Remove extra hashtags"),
            "openCaptions",
        ).with(json!({"n": all_tags.len(), "platform": rules.display_name, "max": meta.hashtag_max})));
    }

    // --- media presence ---
    if target.export_asset_id.is_none() {
        out.push(f(
            "error",
            "no_export",
            "No exported file is linked to this platform target",
            Some("Export for this platform from Social Studio"),
            "pickFile",
        ));
    } else if !media.file_exists {
        out.push(f(
            "error",
            "file_missing",
            "The linked export file no longer exists on disk",
            Some("Re-export or relink the file"),
            "pickFile",
        ));
    }

    // --- technical fit (only when we have facts) ---
    if let (Some(w), Some(h)) = (media.width, media.height) {
        if !vid.aspect_ratios.is_empty() {
            let ok = vid.aspect_ratios.iter().any(|a| {
                // 2% tolerance — 1920x1088 still counts as 16:9.
                let want = a.w as f64 / a.h as f64;
                let have = w as f64 / h as f64;
                (have - want).abs() / want < 0.02
            });
            if !ok {
                let labels: Vec<String> =
                    vid.aspect_ratios.iter().map(|a| a.label.clone()).collect();
                let required = vid.aspect_ratios.iter().any(|a| a.required);
                out.push(f(
                    if required { "error" } else { "warning" },
                    "aspect_mismatch",
                    format!(
                        "{w}×{h} doesn't match {} accepted ratios: {}",
                        rules.display_name,
                        labels.join(", ")
                    ),
                    Some("Create a matching version in Multi-Format"),
                    "openFormats",
                ).with(json!({"w": w, "h": h, "platform": rules.display_name, "labels": labels.join(", ")})));
            }
        }
        let below_rec = !vid.recommended.is_empty()
            && vid.recommended.iter().all(|(rw, rh)| w < *rw || h < *rh);
        if below_rec {
            out.push(
                f(
                    "recommendation",
                    "res_below_recommended",
                    format!(
                        "{w}×{h} is below all recommended resolutions for {}",
                        rules.display_name
                    ),
                    Some("Export at a recommended resolution"),
                    "openFormats",
                )
                .with(json!({"w": w, "h": h, "platform": rules.display_name})),
            );
        }
        if (vid.min_width > 0 && w < vid.min_width) || (vid.min_height > 0 && h < vid.min_height) {
            out.push(f(
                "error",
                "res_below_minimum",
                format!(
                    "{w}×{h} is under the {} minimum ({}×{})",
                    rules.display_name, vid.min_width, vid.min_height
                ),
                Some("Upscale via a larger canvas version"),
                "openFormats",
            ).with(json!({"w": w, "h": h, "platform": rules.display_name, "minw": vid.min_width, "minh": vid.min_height})));
        }
    }

    if let Some(d) = media.duration_ms {
        if vid.max_duration_ms > 0 && d > vid.max_duration_ms {
            out.push(f(
                "error",
                "duration_over",
                format!(
                    "{:.1} min exceeds the {} maximum",
                    d as f64 / 60000.0,
                    rules.display_name
                ),
                Some("Split or shorten the video"),
                "openFormats",
            ).with(json!({"min": format!("{:.1}", d as f64 / 60000.0), "platform": rules.display_name})));
        }
        if vid.min_duration_ms > 0 && d < vid.min_duration_ms {
            out.push(f(
                "error",
                "duration_under",
                format!(
                    "{:.1}s is under the {} minimum of {:.1}s",
                    d as f64 / 1000.0,
                    rules.display_name,
                    vid.min_duration_ms as f64 / 1000.0
                ),
                Some("Extend the video"),
                "openFormats",
            ).with(json!({"sec": format!("{:.1}", d as f64 / 1000.0), "platform": rules.display_name, "minSec": format!("{:.1}", vid.min_duration_ms as f64 / 1000.0)})));
        }
        if vid.short_max_ms > 0 && d > vid.short_max_ms {
            out.push(
                f(
                    "info",
                    "not_a_short",
                    format!(
                        "Over {}s — won't qualify as a short-form placement on {}",
                        vid.short_max_ms / 1000,
                        rules.display_name
                    ),
                    None,
                    "none",
                )
                .with(json!({"sec": vid.short_max_ms / 1000, "platform": rules.display_name})),
            );
        }
    }

    if let Some(b) = media.bytes {
        if vid.max_file_bytes > 0 && b > vid.max_file_bytes {
            out.push(
                f(
                    "error",
                    "file_too_large",
                    format!(
                        "{:.1} GB exceeds the {} file limit",
                        b as f64 / 1e9,
                        rules.display_name
                    ),
                    Some("Export with a lower bitrate"),
                    "openFormats",
                )
                .with(
                    json!({"gb": format!("{:.1}", b as f64 / 1e9), "platform": rules.display_name}),
                ),
            );
        }
    }

    if media.has_audio == Some(false) {
        out.push(f(
            "warning",
            "no_audio",
            "Export has no audio track — most platforms accept it but engagement suffers",
            Some("Add audio or confirm intentional"),
            "none",
        ));
    }

    if let Some(c) = &media.codec {
        if !vid.codecs.is_empty() && !vid.codecs.iter().any(|k| c.to_lowercase().contains(k)) {
            out.push(
                f(
                    "warning",
                    "codec_unlisted",
                    format!(
                        "Codec '{c}' isn't in the documented list for {}",
                        rules.display_name
                    ),
                    Some("Re-export as H.264"),
                    "openFormats",
                )
                .with(json!({"codec": c, "platform": rules.display_name})),
            );
        }
    }

    // --- account / API reality ---
    if !account_connected {
        out.push(
            f(
                "warning",
                "no_account",
                format!(
                    "No {} account connected — export works, publishing doesn't",
                    rules.display_name
                ),
                Some("Connect an account in Social → Accounts"),
                "connectAccount",
            )
            .with(json!({"platform": rules.display_name})),
        );
    }
    if rules.capabilities.requires_app_review {
        out.push(
            f(
                "info",
                "app_review",
                format!(
                    "{} publishing requires an approved developer app. {}",
                    rules.display_name, rules.capabilities.status_note
                ),
                None,
                "none",
            )
            .with(json!({"platform": rules.display_name})),
        );
    }
    if rules.capabilities.requires_hosted_media {
        out.push(
            f(
                "warning",
                "hosted_media",
                format!(
                "{} API cannot ingest local files — the video must be reachable at a public URL",
                rules.display_name
            ),
                Some("Host the file and provide its URL in platform options"),
                "none",
            )
            .with(json!({"platform": rules.display_name})),
        );
    }
    if meta.thumbnail_required && post.thumbnail_asset_id.is_none() {
        out.push(
            f(
                "warning",
                "no_thumbnail",
                format!(
                    "{} recommends/requires a custom thumbnail",
                    rules.display_name
                ),
                Some("Pick a thumbnail in the composer"),
                "pickFile",
            )
            .with(json!({"platform": rules.display_name})),
        );
    }

    // --- scheduling ---
    if let Some(s) = &target.scheduled_at {
        if let Ok(t) = chrono_free_parse(s) {
            if t < now_unix() - 60 {
                out.push(f(
                    "warning",
                    "schedule_past",
                    "Scheduled time is in the past",
                    Some("Pick a future slot in the calendar"),
                    "none",
                ));
            }
        }
    }

    if out.is_empty() {
        out.push(
            f(
                "passed",
                "all_good",
                format!("Ready for {} (rules v{rules_updated})", rules.display_name),
                None,
                "none",
            )
            .with(json!({"platform": rules.display_name, "updated": rules_updated})),
        );
    }
    out
}

/// RFC3339/`YYYY-MM-DDTHH:MM` → unix seconds (no chrono dep — small parser).
pub fn chrono_free_parse(s: &str) -> Result<i64, AppError> {
    // Accept "2026-11-13T14:30", "2026-11-13 14:30", "+00:00" suffixes.
    let s = s.trim().replace(' ', "T");
    let s = s.trim_end_matches('Z');
    let s = s.split('+').next().unwrap_or(s);
    let s = s.split('.').next().unwrap_or(s);
    let parts: Vec<&str> = s.split(['T', '-', ':']).collect();
    if parts.len() < 5 {
        return Err(AppError::InvalidInput(format!("bad datetime: {s}")));
    }
    let (y, mo, d, h, mi) = (
        parts[0]
            .parse::<i64>()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?,
        parts[1]
            .parse::<i64>()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?,
        parts[2]
            .parse::<i64>()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?,
        parts[3]
            .parse::<i64>()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?,
        parts[4]
            .parse::<i64>()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?,
    );
    let sec = parts
        .get(5)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    // days-from-civil → unix seconds (Howard Hinnant's algorithm).
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Ok(days * 86400 + h * 3600 + mi * 60 + sec)
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[tauri::command]
pub fn validate_social_post(
    db: tauri::State<'_, std::sync::Arc<crate::db::Db>>,
    app: tauri::AppHandle,
    post_id: String,
) -> CmdResult<serde_json::Value> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    let ruleset = super::rules::load(&app_data);
    db.with(|conn| {
        let post = conn
            .query_row(
                "SELECT id, project_id, title, caption, hashtags_json,
                        thumbnail_asset_id, notes, status, created_at, updated_at
                 FROM social_posts WHERE id=?1",
                [&post_id],
                |r| {
                    Ok(SocialPost {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        title: r.get(2)?,
                        caption: r.get(3)?,
                        hashtags: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                        thumbnail_asset_id: r.get(5)?,
                        notes: r.get(6)?,
                        status: r.get(7)?,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                        targets: vec![],
                    })
                },
            )
            .map_err(|_| AppError::NotFound(format!("post {post_id}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, post_id, platform, account_id, version_id,
                    export_asset_id, title, caption, hashtags_json,
                    platform_meta_json, status, scheduled_at, auto_publish,
                    platform_post_id, platform_url, last_error, published_at
             FROM social_post_targets WHERE post_id=?1",
        )?;
        let targets = stmt
            .query_map([&post_id], super::posts::row_to_target_pub)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut results = Vec::new();
        for t in &targets {
            let rules = match ruleset.platforms.get(&t.platform) {
                Some(r) => r,
                None => continue,
            };
            // Facts: probe the linked export file if there is one.
            let mut media = MediaFacts::default();
            if let Some(aid) = &t.export_asset_id {
                if let Ok(row) = conn.query_row(
                    "SELECT file_path, width, height, duration_ms, codec,
                            audio_codec, file_size
                     FROM media_assets WHERE id=?1",
                    [aid],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<i64>>(2)?,
                            r.get::<_, Option<i64>>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, Option<String>>(5)?,
                            r.get::<_, Option<i64>>(6)?,
                        ))
                    },
                ) {
                    let path = std::path::Path::new(&row.0);
                    media.file_exists = path.exists();
                    media.width = row.1.map(|v| v as u32);
                    media.height = row.2.map(|v| v as u32);
                    media.duration_ms = row.3;
                    media.codec = row.4;
                    media.has_audio = row.5.as_ref().map(|a| !a.is_empty());
                    media.bytes = row
                        .6
                        .or_else(|| std::fs::metadata(path).ok().map(|m| m.len() as i64));
                }
            }
            let account_connected = t
                .account_id
                .as_ref()
                .map(|aid| {
                    conn.query_row(
                        "SELECT status FROM social_accounts WHERE id=?1",
                        [aid],
                        |r| r.get::<_, String>(0),
                    )
                    .map(|s| s == "active")
                    .unwrap_or(false)
                })
                .unwrap_or(false);
            let findings =
                validate_target(rules, &post, t, &media, account_connected, &ruleset.updated);
            results.push(serde_json::json!({
                "targetId": t.id,
                "platform": t.platform,
                "findings": findings,
            }));
        }
        Ok(serde_json::json!({
            "postId": post_id,
            "rulesVersion": ruleset.version,
            "rulesUpdated": ruleset.updated,
            "targets": results,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::social::model::SocialPost;
    use crate::social::rules::builtin;

    fn post() -> SocialPost {
        SocialPost {
            id: "p".into(),
            project_id: None,
            title: "My video".into(),
            caption: "Nice clip".into(),
            hashtags: vec!["tag".into()],
            thumbnail_asset_id: None,
            notes: None,
            status: "draft".into(),
            created_at: String::new(),
            updated_at: String::new(),
            targets: vec![],
        }
    }

    fn tgt(platform: &str) -> SocialPostTarget {
        SocialPostTarget {
            id: "t".into(),
            post_id: "p".into(),
            platform: platform.into(),
            account_id: None,
            version_id: None,
            export_asset_id: Some("a".into()),
            title: None,
            caption: None,
            hashtags: None,
            platform_meta: serde_json::json!({}),
            status: "draft".into(),
            scheduled_at: None,
            auto_publish: false,
            platform_post_id: None,
            platform_url: None,
            last_error: None,
            published_at: None,
        }
    }

    #[test]
    fn clean_media_plus_account_passes_with_notes_only() {
        let rules = &builtin().platforms["youtube"];
        let media = MediaFacts {
            width: Some(1920),
            height: Some(1080),
            duration_ms: Some(60_000),
            bytes: Some(50_000_000),
            has_audio: Some(true),
            codec: Some("h264".into()),
            file_exists: true,
            ..Default::default()
        };
        let findings = validate_target(rules, &post(), &tgt("youtube"), &media, true, "test");
        assert!(findings.iter().all(|f| f.severity != "error"));
    }

    #[test]
    fn vertical_on_all_platforms_passes_aspect() {
        for p in ["youtube", "tiktok", "instagram", "facebook"] {
            let rules = &builtin().platforms[p];
            let media = MediaFacts {
                width: Some(1080),
                height: Some(1920),
                file_exists: true,
                ..Default::default()
            };
            let f = validate_target(rules, &post(), &tgt(p), &media, true, "t");
            assert!(
                !f.iter().any(|x| x.code == "aspect_mismatch"),
                "{p}: unexpected aspect finding"
            );
        }
    }

    #[test]
    fn no_export_is_an_error_and_long_title_errors() {
        let rules = &builtin().platforms["youtube"];
        let mut t = tgt("youtube");
        t.export_asset_id = None;
        t.title = Some("x".repeat(101));
        let f = validate_target(rules, &post(), &t, &MediaFacts::default(), false, "t");
        assert!(f
            .iter()
            .any(|x| x.code == "no_export" && x.severity == "error"));
        assert!(f
            .iter()
            .any(|x| x.code == "title_too_long" && x.severity == "error"));
        assert!(f.iter().any(|x| x.code == "no_account"));
    }

    #[test]
    fn datetime_parser_handles_local_and_utc() {
        assert!(chrono_free_parse("2026-11-13T14:30").unwrap() > 0);
        assert!(chrono_free_parse("2026-11-13 14:30:00Z").unwrap() > 0);
        assert!(chrono_free_parse("2026-11-13T14:30+01:00").unwrap() > 0);
        assert!(chrono_free_parse("garbage").is_err());
    }
}
