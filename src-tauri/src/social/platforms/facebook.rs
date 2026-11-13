//! Facebook Graph API — REAL Page video upload (resumable session:
//! start → transfer chunks → finish). Needs pages_manage_posts +
//! publish_video + pages_read_engagement on a Page the user manages.
//!
//! meta.pageId (required): which Page to post to.
//! meta.pageAccessToken (optional): resolved automatically via
//! /me/accounts when absent.

use super::http::ep;
use super::{meta_str, PublishInput, PublishOutcome};

fn graph() -> String {
    ep("fb.graph", "https://graph.facebook.com/v21.0")
}
fn graph_video() -> String {
    ep("fb.graph_video", "https://graph-video.facebook.com/v21.0")
}

/// /me → (user id, name).
pub fn identity(access_token: &str) -> Result<(String, Option<String>), String> {
    let body = super::http::get_json(&format!("{}/me?fields=id,name", graph()), access_token)
        .map_err(|e| e.to_message())?;
    if let Some(e) = super::api_err(&body) {
        return Err(format!("facebook identity: {e}"));
    }
    Ok((
        body["id"].as_str().unwrap_or("fb").to_string(),
        body["name"].as_str().map(str::to_string),
    ))
}

/// Resolve the Page access token for meta.pageId via /me/accounts.
fn page_token(user_token: &str, page_id: &str) -> Result<String, String> {
    let body = super::http::get_json(
        &format!(
            "{}/me/accounts?fields=id,name,access_token&limit=100",
            graph()
        ),
        user_token,
    )
    .map_err(|e| e.to_message())?;
    for p in body["data"].as_array().into_iter().flatten() {
        if p["id"].as_str() == Some(page_id) {
            return p["access_token"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "page has no access_token".into());
        }
    }
    Err(format!("page {page_id} not found under /me/accounts"))
}

const CHUNK: usize = 8 << 20; // 8 MiB per transfer chunk.

pub fn publish(
    token: &str,
    input: &PublishInput,
    progress: &super::Progress<'_>,
    cancelled: &super::Cancelled<'_>,
) -> Result<PublishOutcome, String> {
    let path = super::require_file(input)?;
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let page_id = meta_str(input, "pageId")
        .ok_or("meta.pageId required — pick the target Page in options")?;
    let ptoken = meta_str(input, "pageAccessToken")
        .map(str::to_string)
        .unwrap_or_else(|| page_token(token, page_id).unwrap_or_default());
    if ptoken.is_empty() {
        return Err(format!("could not resolve access token for page {page_id}"));
    }

    let base = format!("{}/{page_id}/videos", graph_video());

    // 1) upload_phase=start → session id + first offset window.
    let start = super::http::post_json(
        &base,
        &ptoken,
        &serde_json::json!({"upload_phase": "start", "file_size": size}),
    )
    .map_err(|e| e.to_message())?;
    if let Some(e) = super::api_err(&start) {
        return Err(format!("upload start: {e}"));
    }
    let session = start["upload_session_id"]
        .as_str()
        .ok_or("no upload_session_id")?
        .to_string();
    let video_id = start["video_id"].as_str().map(str::to_string);
    let mut offset: u64 = start["start_offset"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut end: u64 = start["end_offset"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(size);

    // 2) transfer chunks — server dictates each [start,end) window.
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    use std::io::{Read, Seek, SeekFrom};
    while offset < size {
        if cancelled() {
            return Err("cancelled".into());
        }
        let want = (end - offset).min(CHUNK as u64) as usize;
        let mut buf = vec![0u8; want];
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.truncate(n);

        let start_offset = offset.to_string();
        let form = ureq::unversioned::multipart::Form::new()
            .text("upload_phase", "transfer")
            .text("upload_session_id", &session)
            .text("start_offset", &start_offset)
            .text("access_token", &ptoken)
            .part(
                "video_file_chunk",
                ureq::unversioned::multipart::Part::bytes(&buf)
                    .file_name("chunk.mp4")
                    .mime_str("video/mp4")
                    .map_err(|e| e.to_string())?,
            );
        let resp = ureq::post(&base)
            .send(form)
            .map_err(|e| format!("transfer chunk @{offset}: {e}"))?;
        let body: serde_json::Value = resp
            .into_body()
            .read_json()
            .map_err(|e| format!("transfer body: {e}"))?;
        if let Some(e) = super::api_err(&body) {
            return Err(format!("transfer @{offset}: {e}"));
        }
        offset = body["start_offset"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(offset + n as u64);
        end = body["end_offset"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(size);
        progress(offset.min(size), size);
    }

    // 3) finish — attach title/description.
    let mut finish = serde_json::json!({
        "upload_phase": "finish",
        "upload_session_id": session,
    });
    if !input.title.is_empty() {
        finish["title"] = serde_json::json!(input.title);
    }
    if !input.description.is_empty() {
        finish["description"] = serde_json::json!(input.description);
    }
    let fin = super::http::post_json(&base, &ptoken, &finish).map_err(|e| e.to_message())?;
    if let Some(e) = super::api_err(&fin) {
        return Err(format!("upload finish: {e}"));
    }
    Ok(PublishOutcome {
        platform_post_id: video_id.clone(),
        url: video_id.map(|v| format!("https://facebook.com/{v}")),
        raw: fin,
    })
}
