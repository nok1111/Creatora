//! YouTube Data API v3 — REAL implementation: resumable upload protocol
//! (initiate → chunked PUT with Content-Range → video resource) +
//! channels identity. Requires the user's Google OAuth client with
//! youtube.upload + youtube.readonly scopes.

use super::http::ep;
use super::{api_err, meta_bool, meta_str, PublishInput, PublishOutcome};

/// channels.list mine=true → (channel id, channel title).
pub fn identity(access_token: &str) -> Result<(String, Option<String>), String> {
    let body = super::http::get_json(
        &format!(
            "{}/youtube/v3/channels?part=snippet&mine=true",
            ep("youtube.api", "https://www.googleapis.com")
        ),
        access_token,
    )
    .map_err(|e| e.to_message())?;
    let item = body["items"].get(0).ok_or("no channel on account")?;
    let id = item["id"].as_str().unwrap_or("yt").to_string();
    let name = item["snippet"]["title"].as_str().map(str::to_string);
    Ok((id, name))
}

const CHUNK: usize = 4 << 20; // 4 MiB — multiple of 256 KiB per spec.

/// Resumable upload: POST initiate → PUT chunks → done.
/// `privacyStatus`: private (default — unverified apps are forced
/// private anyway), unlisted, public.
pub fn publish(
    token: &str,
    input: &PublishInput,
    progress: &super::Progress<'_>,
    cancelled: &super::Cancelled<'_>,
) -> Result<PublishOutcome, String> {
    let path = super::require_file(input)?;
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();

    let privacy = meta_str(input, "privacy").unwrap_or("private");
    let snippet = serde_json::json!({
        "title": input.title,
        "description": input.description,
        "tags": input.tags,
        "categoryId": meta_str(input, "categoryId").unwrap_or("22"),
    });
    let status = serde_json::json!({
        "privacyStatus": privacy,
        "selfDeclaredMadeForKids": meta_bool(input, "madeForKids"),
    });

    // 1) Initiate resumable session — POST metadata, get Location.
    let resp = ureq::post(&format!(
        "{}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        ep("youtube.upload", "https://upload.youtube.com")
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .header("X-Upload-Content-Length", &size.to_string())
    .header("X-Upload-Content-Type", "video/*")
    .send_json(serde_json::json!({"snippet": snippet, "status": status}))
    .map_err(|e| format!("initiate upload: {e}"))?;
    let upload_url = resp
        .headers()
        .get("Location")
        .and_then(|v| v.to_str().ok())
        .ok_or("no resumable Location header")?
        .to_string();

    // 2) PUT the file in 4 MiB chunks with Content-Range.
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut sent: u64 = 0;
    let mut buf = vec![0u8; CHUNK];
    use std::io::Read;
    let mut video: Option<serde_json::Value> = None;
    while sent < size {
        if cancelled() {
            return Err("cancelled".into());
        }
        let want = std::cmp::min(CHUNK as u64, size - sent) as usize;
        let n = file.read(&mut buf[..want]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let end = sent + n as u64 - 1;
        let range = format!("bytes {sent}-{end}/{size}");
        let resp = ureq::put(&upload_url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Range", &range)
            .content_type("video/*")
            .send(&buf[..n])
            .map_err(|e| format!("chunk {range}: {e}"))?;
        sent += n as u64;
        progress(sent, size);
        // Final chunk returns 201 + video resource; intermediates 308.
        if resp.status().as_u16() == 201 || resp.status().as_u16() == 200 {
            video = Some(
                resp.into_body()
                    .read_json()
                    .map_err(|e| format!("video resource: {e}"))?,
            );
        }
    }

    let body = video.ok_or("upload finished without video resource")?;
    if let Some(err) = api_err(&body) {
        return Err(format!("youtube API: {err}"));
    }
    let vid = body["id"]
        .as_str()
        .ok_or("no video id in response")?
        .to_string();
    Ok(PublishOutcome {
        platform_post_id: Some(vid.clone()),
        url: Some(format!("https://youtube.com/watch?v={vid}")),
        raw: body,
    })
}

/// videos.list status — is processing done / did the upload fail?
pub fn status(token: &str, video_id: &str) -> Result<serde_json::Value, String> {
    super::http::get_json(
        &format!(
            "{}/youtube/v3/videos?part=status,processingDetails&id={video_id}",
            ep("youtube.api", "https://www.googleapis.com")
        ),
        token,
    )
    .map_err(|e| e.to_message())
}
