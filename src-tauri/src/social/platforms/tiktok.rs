//! TikTok Content Posting API v2 — REAL code path, honest capability.
//!
//! FILE_UPLOAD flow: init inbox/direct publish → PUT chunks to the
//! presigned upload_url → poll status/fetch.
//!
//! Production reality (documented, not hidden): `video.publish` (direct
//! post) requires an audited app — most developer apps only get
//! `video.upload`, which delivers to the user's TikTok drafts/inbox.
//! meta.mode: "inbox" (default, works for unapproved apps) | "direct"
//! (needs video.publish grant — API decides, we surface real errors).

use super::{meta_bool, meta_str, post_json, PublishInput, PublishOutcome};

/// user/info → (open_id, display_name).
pub fn identity(access_token: &str) -> Result<(String, Option<String>), String> {
    let body = super::get_json(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
        access_token,
    )?;
    if let Some(e) = super::api_err(&body) {
        return Err(format!("tiktok user info: {e}"));
    }
    let user = &body["data"]["user"];
    Ok((
        user["open_id"].as_str().unwrap_or("tt").to_string(),
        user["display_name"].as_str().map(str::to_string),
    ))
}

const CHUNK: usize = 16 << 20; // 16 MiB — TikTok allows 5–64 MiB chunks.

pub fn publish(
    token: &str,
    input: &PublishInput,
    progress: &super::Progress<'_>,
    cancelled: &super::Cancelled<'_>,
) -> Result<PublishOutcome, String> {
    let path = super::require_file(input)?;
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let mode = meta_str(input, "mode").unwrap_or("inbox");
    let direct = mode == "direct";

    // 1) Init upload session. Inbox = drafts flow; direct = post.
    let init_url = if direct {
        "https://open.tiktokapis.com/v2/post/publish/video/init/"
    } else {
        "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/"
    };
    let chunk = CHUNK as u64;
    let chunk_count = size.div_ceil(chunk);
    let mut init_body = serde_json::json!({
        "source_info": {
            "source": "FILE_UPLOAD",
            "video_size": size,
            "chunk_size": chunk,
            "total_chunk_count": chunk_count,
        }
    });
    if direct {
        init_body["post_info"] = serde_json::json!({
            "title": input.description,
            "privacy_level": meta_str(input, "privacy")
                .unwrap_or("SELF_ONLY"),
            "disable_duet": meta_bool(input, "disableDuet"),
            "disable_comment": meta_bool(input, "disableComment"),
            "disable_stitch": meta_bool(input, "disableStitch"),
        });
    }
    let body = post_json(init_url, token, &init_body)?;
    if let Some(e) = super::api_err(&body) {
        return Err(format!("tiktok init: {e}"));
    }
    let data = &body["data"];
    let publish_id = data["publish_id"]
        .as_str()
        .ok_or("no publish_id in init response")?
        .to_string();
    let upload_url = data["upload_url"]
        .as_str()
        .ok_or("no upload_url in init response")?
        .to_string();

    // 2) PUT raw chunks to the presigned URL (Content-Type video/mp4).
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    use std::io::Read;
    let mut sent: u64 = 0;
    let mut buf = vec![0u8; CHUNK];
    while sent < size {
        if cancelled() {
            return Err("cancelled".into());
        }
        let want = std::cmp::min(chunk, size - sent) as usize;
        let n = file.read(&mut buf[..want]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let end = sent + n as u64 - 1;
        ureq::put(&upload_url)
            .header("Content-Range", &format!("bytes {sent}-{end}/{size}"))
            .content_type("video/mp4")
            .send(&buf[..n])
            .map_err(|e| format!("tiktok chunk: {e}"))?;
        sent += n as u64;
        progress(sent, size);
    }

    // 3) Poll status until settled (PROCESSING → PUBLISH_COMPLETE or
    //    SEND_TO_USER_INBOX for drafts).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        if cancelled() {
            return Err("cancelled".into());
        }
        if std::time::Instant::now() > deadline {
            // Upload accepted; status unknown — report publish_id only.
            return Ok(PublishOutcome {
                platform_post_id: Some(publish_id),
                url: None,
                raw: serde_json::json!({"note": "status poll timed out; upload accepted"}),
            });
        }
        let st = post_json(
            "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
            token,
            &serde_json::json!({"publish_id": publish_id}),
        )?;
        let status = st["data"]["status"].as_str().unwrap_or("");
        match status {
            "PUBLISH_COMPLETE" => {
                return Ok(PublishOutcome {
                    platform_post_id: Some(publish_id),
                    url: None, // TikTok API doesn't hand back a public URL
                    raw: st,
                });
            }
            "SEND_TO_USER_INBOX" => {
                return Ok(PublishOutcome {
                    platform_post_id: Some(publish_id),
                    url: None,
                    raw: serde_json::json!({
                        "status": st,
                        "note": "Video landed in TikTok drafts — user publishes from the app (inbox mode).",
                    }),
                });
            }
            "FAILED" => {
                let fail = st["data"]["fail_reason"].as_str().unwrap_or("unknown");
                return Err(format!("tiktok publish failed: {fail}"));
            }
            _ => std::thread::sleep(std::time::Duration::from_secs(3)),
        }
    }
}
