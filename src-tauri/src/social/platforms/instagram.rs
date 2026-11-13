//! Instagram Graph API content publishing — REAL but with a hard
//! external constraint the code does not hide: the API only accepts a
//! **publicly reachable media URL**, it cannot ingest a local file.
//!
//! Flow (real): create media container → poll container status →
//! publish container. Works only when:
//!
//! 1. the IG account is Business/Creator linked to a managed Page
//! 2. the Meta app has instagram_content_publish (App Review)
//! 3. the user supplies `hostedUrl` (their own CDN/hosting)
//!
//! Otherwise publish() returns a structured error explaining precisely
//! what's missing — never a fake success.

use super::http::{ep, post_json};
use super::{meta_str, PublishInput, PublishOutcome};

fn graph() -> String {
    ep("fb.graph", "https://graph.facebook.com/v21.0")
}

/// /me → (user id, name). IG professional identity is resolved via
/// the linked Page at publish time.
pub fn identity(access_token: &str) -> Result<(String, Option<String>), String> {
    let body = super::http::get_json(&format!("{}/me?fields=id,name", graph()), access_token)
        .map_err(|e| e.to_message())?;
    Ok((
        body["id"].as_str().unwrap_or("ig").to_string(),
        body["name"].as_str().map(str::to_string),
    ))
}

/// Resolve the IG Business/Creator user id linked to meta.pageId.
fn ig_user_id(token: &str, page_id: &str) -> Result<String, String> {
    let body = super::http::get_json(
        &format!("{}/{page_id}?fields=instagram_business_account", graph()),
        token,
    )
    .map_err(|e| e.to_message())?;
    body["instagram_business_account"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("page {page_id} has no instagram_business_account linked"))
}

pub fn publish(
    token: &str,
    input: &PublishInput,
    _progress: &super::Progress<'_>,
    cancelled: &super::Cancelled<'_>,
) -> Result<PublishOutcome, String> {
    // Hard, honest gate: no local-file path exists in this API.
    let url = input
        .hosted_url
        .clone()
        .or_else(|| meta_str(input, "hostedUrl").map(str::to_string))
        .ok_or_else(|| {
            "Instagram publishing requires a public video URL — the Graph \
             API cannot upload local files. Host the exported file \
             (your CDN/hosting) and set hostedUrl in platform options."
                .to_string()
        })?;
    let ig_id = match meta_str(input, "igUserId").map(str::to_string) {
        Some(id) => id.to_string(),
        None => {
            let page_id = meta_str(input, "pageId")
                .ok_or("meta.pageId or meta.igUserId required for Instagram")?;
            ig_user_id(token, page_id)?
        }
    };
    if cancelled() {
        return Err("cancelled".into());
    }

    // 1) Create container (REELS for video; IMAGE for pictures).
    let is_image = url
        .rsplit('.')
        .next()
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
        .unwrap_or(false);
    let mut create = serde_json::json!({
        "caption": input.description,
        "access_token": token,
    });
    if is_image {
        create["image_url"] = serde_json::json!(url);
    } else {
        create["video_url"] = serde_json::json!(url);
        create["media_type"] = serde_json::json!(meta_str(input, "mediaType").unwrap_or("REELS"));
    }
    let cont = post_json(&format!("{}/{ig_id}/media", graph()), token, &create)
        .map_err(|e| e.to_message())?;
    if let Some(e) = super::api_err(&cont) {
        return Err(format!("container create: {e}"));
    }
    let creation = cont["id"].as_str().ok_or("no creation id")?.to_string();

    // 2) Poll container status (IN_PROGRESS → FINISHED).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        if cancelled() {
            return Err("cancelled".into());
        }
        if std::time::Instant::now() > deadline {
            return Err("container processing timed out".into());
        }
        let st = super::http::get_json(
            &format!("{}/{creation}?fields=status_code,status", graph()),
            token,
        )
        .map_err(|e| e.to_message())?;
        match st["status_code"].as_str().unwrap_or("") {
            "FINISHED" | "PUBLISHED" => break,
            "ERROR" | "EXPIRED" => {
                let detail = st["status"].as_str().unwrap_or("container failed");
                return Err(format!("container failed: {detail}"));
            }
            _ => std::thread::sleep(std::time::Duration::from_secs(5)),
        }
    }

    // 3) Publish the container.
    let pub_resp = post_json(
        &format!("{}/{ig_id}/media_publish", graph()),
        token,
        &serde_json::json!({
            "creation_id": creation,
            "access_token": token,
        }),
    )
    .map_err(|e| e.to_message())?;
    if let Some(e) = super::api_err(&pub_resp) {
        return Err(format!("media_publish: {e}"));
    }
    let media_id = pub_resp["id"].as_str().map(str::to_string);
    Ok(PublishOutcome {
        platform_post_id: media_id,
        url: None, // permalink requires a follow-up /{media}?fields=permalink
        raw: pub_resp,
    })
}
