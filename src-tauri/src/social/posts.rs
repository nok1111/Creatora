//! CRUD for posts, targets, caption templates, hashtag history, accounts.
//! All local-first — every command works offline with zero accounts.

use super::model::{
    aggregate_status, dedupe_hashtags, valid_platform, CaptionTemplate, PublicationAttempt,
    SocialAccount, SocialPost, SocialPostTarget,
};
use crate::db::Db;
use crate::error::{AppError, CmdResult};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

fn now_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn row_to_target_pub(r: &rusqlite::Row) -> rusqlite::Result<SocialPostTarget> {
    let tags: Option<String> = r.get(8)?;
    Ok(SocialPostTarget {
        id: r.get(0)?,
        post_id: r.get(1)?,
        platform: r.get(2)?,
        account_id: r.get(3)?,
        version_id: r.get(4)?,
        export_asset_id: r.get(5)?,
        title: r.get(6)?,
        caption: r.get(7)?,
        hashtags: tags.and_then(|s| serde_json::from_str(&s).ok()),
        platform_meta: serde_json::from_str(&r.get::<_, String>(9)?)
            .unwrap_or(serde_json::json!({})),
        status: r.get(10)?,
        scheduled_at: r.get(11)?,
        auto_publish: r.get::<_, i64>(12)? != 0,
        platform_post_id: r.get(13)?,
        platform_url: r.get(14)?,
        last_error: r.get(15)?,
        published_at: r.get(16)?,
    })
}

const TARGET_COLS: &str = "id, post_id, platform, account_id, version_id,
    export_asset_id, title, caption, hashtags_json, platform_meta_json,
    status, scheduled_at, auto_publish, platform_post_id, platform_url,
    last_error, published_at";

fn targets_of(conn: &Connection, post_id: &str) -> Result<Vec<SocialPostTarget>, AppError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TARGET_COLS} FROM social_post_targets WHERE post_id = ?1 \
         ORDER BY platform"
    ))?;
    let rows = stmt
        .query_map([post_id], row_to_target_pub)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn row_to_post(r: &rusqlite::Row) -> rusqlite::Result<SocialPost> {
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
}

const POST_COLS: &str = "id, project_id, title, caption, hashtags_json,
    thumbnail_asset_id, notes, status, created_at, updated_at";

fn record_hashtags(conn: &Connection, tags: &[String]) -> Result<(), AppError> {
    for t in dedupe_hashtags(tags) {
        conn.execute(
            "INSERT INTO hashtag_history(tag, uses) VALUES(?1, 1)
             ON CONFLICT(tag) DO UPDATE SET uses = uses + 1,
                 last_used_at = datetime('now')",
            [t],
        )?;
    }
    Ok(())
}

fn refresh_post_status(conn: &Connection, post_id: &str) -> Result<(), AppError> {
    let targets = targets_of(conn, post_id)?;
    conn.execute(
        "UPDATE social_posts SET status = ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![aggregate_status(&targets), post_id],
    )?;
    Ok(())
}

/// pub(crate) wrapper so publish.rs can roll status on failure.
pub(crate) fn refresh_post_status_pub(conn: &Connection, post_id: &str) -> Result<(), AppError> {
    refresh_post_status(conn, post_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInput {
    pub platform: String,
    pub account_id: Option<String>,
    pub version_id: Option<String>,
    pub title: Option<String>,
    pub caption: Option<String>,
    pub hashtags: Option<Vec<String>>,
    #[serde(default)]
    pub platform_meta: serde_json::Value,
    pub scheduled_at: Option<String>,
    #[serde(default)]
    pub auto_publish: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostInput {
    pub project_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub hashtags: Vec<String>,
    pub thumbnail_asset_id: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub targets: Vec<TargetInput>,
}

#[tauri::command]
pub fn create_social_post(db: State<'_, Arc<Db>>, input: PostInput) -> CmdResult<SocialPost> {
    db.with(|conn| save_post(conn, None, &input, false))
}

#[tauri::command]
pub fn update_social_post(
    db: State<'_, Arc<Db>>,
    id: String,
    input: PostInput,
) -> CmdResult<SocialPost> {
    let hashtags = dedupe_hashtags(&input.hashtags);
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE social_posts SET title=?1, caption=?2, hashtags_json=?3,
                 thumbnail_asset_id=?4, notes=?5, project_id=?6,
                 updated_at=datetime('now')
             WHERE id=?7",
            params![
                input.title,
                input.caption,
                serde_json::to_string(&hashtags).unwrap(),
                input.thumbnail_asset_id,
                input.notes,
                input.project_id,
                id
            ],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("post {id}")));
        }
        record_hashtags(conn, &hashtags)?;
        refresh_post_status(conn, &id)?;
        let mut p = get_post(conn, &id)?;
        p.targets = targets_of(conn, &id)?;
        Ok(p)
    })
}

fn get_post(conn: &Connection, id: &str) -> Result<SocialPost, AppError> {
    conn.query_row(
        &format!("SELECT {POST_COLS} FROM social_posts WHERE id = ?1"),
        [id],
        row_to_post,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound(format!("post {id}")),
        e => e.into(),
    })
}

#[tauri::command]
pub fn get_social_post(db: State<'_, Arc<Db>>, id: String) -> CmdResult<SocialPost> {
    db.with(|conn| {
        let mut p = get_post(conn, &id)?;
        p.targets = targets_of(conn, &id)?;
        Ok(p)
    })
}

#[tauri::command]
pub fn list_social_posts(
    db: State<'_, Arc<Db>>,
    status: Option<String>,
    platform: Option<String>,
    query: Option<String>,
) -> CmdResult<Vec<SocialPost>> {
    db.with(|conn| {
        let mut sql = format!("SELECT DISTINCT {POST_COLS} FROM social_posts p WHERE 1=1");
        let mut params_v: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut next = |v: Box<dyn rusqlite::ToSql>| {
            params_v.push(v);
            format!("?{}", params_v.len())
        };
        if let Some(s) = &status {
            if !s.is_empty() {
                sql.push_str(&format!(" AND p.status = {}", next(Box::new(s.clone()))));
            }
        }
        if let Some(pl) = &platform {
            if !pl.is_empty() {
                sql.push_str(&format!(
                    " AND EXISTS (SELECT 1 FROM social_post_targets t
                     WHERE t.post_id = p.id AND t.platform = {})",
                    next(Box::new(pl.clone()))
                ));
            }
        }
        if let Some(q) = &query {
            if !q.is_empty() {
                sql.push_str(&format!(
                    " AND (p.title LIKE {} OR p.caption LIKE {})",
                    next(Box::new(format!("%{q}%"))),
                    next(Box::new(format!("%{q}%")))
                ));
            }
        }
        sql.push_str(" ORDER BY p.updated_at DESC LIMIT 500");
        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = params_v.iter().map(|p| p.as_ref()).collect();
        let mut posts = stmt
            .query_map(refs.as_slice(), row_to_post)?
            .collect::<Result<Vec<_>, _>>()?;
        for p in &mut posts {
            p.targets = targets_of(conn, &p.id)?;
        }
        Ok(posts)
    })
}

#[tauri::command]
pub fn delete_social_post(db: State<'_, Arc<Db>>, id: String) -> CmdResult<()> {
    db.with(|conn| {
        let n = conn.execute("DELETE FROM social_posts WHERE id = ?1", [&id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("post {id}")));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn duplicate_social_post(db: State<'_, Arc<Db>>, id: String) -> CmdResult<SocialPost> {
    db.with(|conn| {
        let src = get_post(conn, &id)?;
        let src_targets = targets_of(conn, &id)?;
        let new_id = now_uuid();
        conn.execute(
            "INSERT INTO social_posts(id, project_id, title, caption,
                 hashtags_json, thumbnail_asset_id, notes, status)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'draft')",
            params![
                new_id,
                src.project_id,
                format!("{} (copy)", src.title),
                src.caption,
                serde_json::to_string(&src.hashtags).unwrap(),
                src.thumbnail_asset_id,
                src.notes,
            ],
        )?;
        for t in &src_targets {
            conn.execute(
                &format!(
                    "INSERT INTO social_post_targets({TARGET_COLS})
                     VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,'draft',
                             NULL,?10,NULL,NULL,NULL,NULL)"
                ),
                params![
                    now_uuid(),
                    new_id,
                    t.platform,
                    t.account_id,
                    t.version_id,
                    t.title,
                    t.caption,
                    t.hashtags
                        .as_ref()
                        .map(|h| serde_json::to_string(h).unwrap()),
                    serde_json::to_string(&t.platform_meta).unwrap(),
                    t.auto_publish as i64,
                ],
            )?;
        }
        let mut p = get_post(conn, &new_id)?;
        p.targets = targets_of(conn, &new_id)?;
        Ok(p)
    })
}

// ---- targets ----

#[tauri::command]
pub fn upsert_post_target(
    db: State<'_, Arc<Db>>,
    post_id: String,
    input: TargetInput,
) -> CmdResult<SocialPostTarget> {
    db.with(|conn| upsert_target(conn, &post_id, &input))
}

/// Status a target takes when its editable fields are saved. System-owned
/// states (`published`, `publishing`) are never rewritten by an edit; a
/// schedule promotes to `scheduled`; otherwise `ready`/`failed`/`cancelled`
/// survive and anything else falls back to `draft`.
pub(crate) fn next_target_status(existing: Option<&str>, scheduled: bool) -> &'static str {
    match existing {
        Some("published") => "published",
        Some("publishing") => "publishing",
        _ if scheduled => "scheduled",
        Some("ready") => "ready",
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        _ => "draft",
    }
}

fn target_key(platform: &str, version_id: &Option<String>) -> (String, String) {
    (platform.to_string(), version_id.clone().unwrap_or_default())
}

pub(crate) fn upsert_target(
    conn: &Connection,
    post_id: &str,
    input: &TargetInput,
) -> Result<SocialPostTarget, AppError> {
    if !valid_platform(&input.platform) {
        return Err(AppError::InvalidInput(format!(
            "unknown platform: {}",
            input.platform
        )));
    }
    let tags = input
        .hashtags
        .as_ref()
        .map(|h| serde_json::to_string(&dedupe_hashtags(h)).unwrap());
    let meta = serde_json::to_string(&input.platform_meta).unwrap();
    {
        // Upsert on (post_id, platform, version_id) — version NULL stored
        // as '' to make UNIQUE work in SQLite (NULLs never equal).
        let ver = input.version_id.clone().unwrap_or_default();
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, status FROM social_post_targets
                 WHERE post_id=?1 AND platform=?2
                   AND COALESCE(version_id,'')=?3",
                params![post_id, input.platform, ver],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let status = next_target_status(
            existing.as_ref().map(|e| e.1.as_str()),
            input.scheduled_at.is_some(),
        );
        let tid = match existing.map(|e| e.0) {
            Some(tid) => {
                conn.execute(
                    "UPDATE social_post_targets SET account_id=?1,
                         version_id=?2, title=?3, caption=?4,
                         hashtags_json=?5, platform_meta_json=?6,
                         scheduled_at=?7, auto_publish=?8, status=?9,
                         updated_at=datetime('now')
                     WHERE id=?10",
                    params![
                        input.account_id,
                        input.version_id,
                        input.title,
                        input.caption,
                        tags,
                        meta,
                        input.scheduled_at,
                        input.auto_publish as i64,
                        status,
                        tid
                    ],
                )?;
                tid
            }
            None => {
                let tid = now_uuid();
                conn.execute(
                    &format!(
                        "INSERT INTO social_post_targets({TARGET_COLS})
                         VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10,?11,
                                ?12,NULL,NULL,NULL,NULL)"
                    ),
                    params![
                        tid,
                        post_id,
                        input.platform,
                        input.account_id,
                        input.version_id,
                        input.title,
                        input.caption,
                        tags,
                        meta,
                        status,
                        input.scheduled_at,
                        input.auto_publish as i64,
                    ],
                )?;
                tid
            }
        };
        if let Some(hs) = &input.hashtags {
            record_hashtags(conn, hs)?;
        }
        refresh_post_status(conn, post_id)?;
        Ok(conn.query_row(
            &format!("SELECT {TARGET_COLS} FROM social_post_targets WHERE id=?1"),
            [&tid],
            row_to_target_pub,
        )?)
    }
}

/// Create-or-update a post and reconcile its targets in ONE transaction:
/// every input target is upserted (duplicate platform/version entries
/// collapse), targets absent from the input are removed unless they are
/// already published/publishing (their history must survive), and
/// `mark_ready` promotes draft targets. Any failure rolls everything back.
pub(crate) fn save_post(
    conn: &Connection,
    id: Option<&str>,
    input: &PostInput,
    mark_ready: bool,
) -> Result<SocialPost, AppError> {
    for t in &input.targets {
        if !valid_platform(&t.platform) {
            return Err(AppError::InvalidInput(format!(
                "unknown platform: {}",
                t.platform
            )));
        }
    }
    let hashtags = dedupe_hashtags(&input.hashtags);
    let tags_json = serde_json::to_string(&hashtags).unwrap();
    let tx = conn.unchecked_transaction()?;
    let post_id = match id {
        Some(id) => {
            let changed = tx.execute(
                "UPDATE social_posts SET title=?1, caption=?2, hashtags_json=?3,
                     thumbnail_asset_id=?4, notes=?5, project_id=?6,
                     updated_at=datetime('now')
                 WHERE id=?7",
                params![
                    input.title,
                    input.caption,
                    tags_json,
                    input.thumbnail_asset_id,
                    input.notes,
                    input.project_id,
                    id
                ],
            )?;
            if changed == 0 {
                return Err(AppError::NotFound(format!("post {id}")));
            }
            id.to_string()
        }
        None => {
            let id = now_uuid();
            tx.execute(
                "INSERT INTO social_posts(id, project_id, title, caption,
                     hashtags_json, thumbnail_asset_id, notes, status)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,'draft')",
                params![
                    id,
                    input.project_id,
                    input.title,
                    input.caption,
                    tags_json,
                    input.thumbnail_asset_id,
                    input.notes,
                ],
            )?;
            id
        }
    };
    record_hashtags(&tx, &hashtags)?;
    let mut keep = std::collections::BTreeSet::new();
    for t in &input.targets {
        keep.insert(target_key(&t.platform, &t.version_id));
        let saved = upsert_target(&tx, &post_id, t)?;
        if mark_ready && saved.status == "draft" {
            tx.execute(
                "UPDATE social_post_targets SET status='ready',
                     updated_at=datetime('now') WHERE id=?1",
                [&saved.id],
            )?;
        }
    }
    for existing in targets_of(&tx, &post_id)? {
        if !keep.contains(&target_key(&existing.platform, &existing.version_id))
            && !matches!(existing.status.as_str(), "published" | "publishing")
        {
            tx.execute(
                "DELETE FROM social_post_targets WHERE id=?1",
                [&existing.id],
            )?;
        }
    }
    refresh_post_status(&tx, &post_id)?;
    let mut p = get_post(&tx, &post_id)?;
    p.targets = targets_of(&tx, &post_id)?;
    tx.commit()?;
    Ok(p)
}

#[tauri::command]
pub fn save_social_post(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    input: PostInput,
    mark_ready: bool,
) -> CmdResult<SocialPost> {
    db.with(|conn| save_post(conn, id.as_deref(), &input, mark_ready))
}

#[tauri::command]
pub fn delete_post_target(db: State<'_, Arc<Db>>, id: String) -> CmdResult<()> {
    db.with(|conn| {
        let post: String = conn
            .query_row(
                "SELECT post_id FROM social_post_targets WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound(format!("target {id}")))?;
        conn.execute("DELETE FROM social_post_targets WHERE id=?1", [&id])?;
        refresh_post_status(conn, &post)?;
        Ok(())
    })
}

/// Explicit status moves the UI may request (ready / draft / cancel).
/// 'published'/'publishing'/'failed' are system-owned — set only by the
/// publish path on real API results.
#[tauri::command]
pub fn set_target_status(db: State<'_, Arc<Db>>, id: String, status: String) -> CmdResult<()> {
    if !["draft", "ready", "cancelled"].contains(&status.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "status '{status}' is system-owned; only draft/ready/cancelled may be set"
        )));
    }
    db.with(|conn| {
        let post: String = conn
            .query_row(
                "SELECT post_id FROM social_post_targets WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound(format!("target {id}")))?;
        conn.execute(
            "UPDATE social_post_targets SET status=?1,
                 scheduled_at = CASE WHEN ?1 IN ('draft','ready','cancelled')
                                     THEN NULL ELSE scheduled_at END,
                 updated_at=datetime('now') WHERE id=?2",
            params![status, id],
        )?;
        refresh_post_status(conn, &post)?;
        Ok(())
    })
}

#[tauri::command]
pub fn schedule_post_target(
    db: State<'_, Arc<Db>>,
    id: String,
    scheduled_at: Option<String>,
    auto_publish: bool,
) -> CmdResult<()> {
    db.with(|conn| {
        let (post, current): (String, String) = conn
            .query_row(
                "SELECT post_id, status FROM social_post_targets WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::NotFound(format!("target {id}")))?;
        let status = next_target_status(Some(&current), scheduled_at.is_some());
        conn.execute(
            "UPDATE social_post_targets SET scheduled_at=?1, auto_publish=?2,
                 status=?3, updated_at=datetime('now') WHERE id=?4",
            params![scheduled_at, auto_publish as i64, status, id],
        )?;
        refresh_post_status(conn, &post)?;
        Ok(())
    })
}

/// Link an exported media asset to a target (real file on disk).
#[tauri::command]
pub fn link_target_media(
    db: State<'_, Arc<Db>>,
    target_id: String,
    asset_id: Option<String>,
) -> CmdResult<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE social_post_targets SET export_asset_id=?1,
                 updated_at=datetime('now') WHERE id=?2",
            params![asset_id, target_id],
        )?;
        Ok(())
    })
}

// ---- caption templates + hashtag history ----

#[tauri::command]
pub fn list_caption_templates(db: State<'_, Arc<Db>>) -> CmdResult<Vec<CaptionTemplate>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, body, hashtags_json, created_at, updated_at
             FROM caption_templates ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CaptionTemplate {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    body: r.get(2)?,
                    hashtags: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn save_caption_template(
    db: State<'_, Arc<Db>>,
    id: Option<String>,
    name: String,
    body: String,
    hashtags: Vec<String>,
) -> CmdResult<String> {
    let tags = serde_json::to_string(&dedupe_hashtags(&hashtags)).unwrap();
    db.with(|conn| {
        let tid = match &id {
            Some(tid) => {
                conn.execute(
                    "UPDATE caption_templates SET name=?1, body=?2,
                         hashtags_json=?3, updated_at=datetime('now')
                     WHERE id=?4",
                    params![name, body, tags, tid],
                )?;
                tid.clone()
            }
            None => {
                let tid = now_uuid();
                conn.execute(
                    "INSERT INTO caption_templates(id,name,body,hashtags_json)
                     VALUES(?1,?2,?3,?4)",
                    params![tid, name, body, tags],
                )?;
                tid
            }
        };
        Ok(tid)
    })
}

#[tauri::command]
pub fn delete_caption_template(db: State<'_, Arc<Db>>, id: String) -> CmdResult<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM caption_templates WHERE id=?1", [&id])?;
        Ok(())
    })
}

/// Recent/most-used hashtags for the manager's suggestion row.
#[tauri::command]
pub fn list_hashtag_history(db: State<'_, Arc<Db>>, limit: Option<i64>) -> CmdResult<Vec<String>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT tag FROM hashtag_history
             ORDER BY uses DESC, last_used_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit.unwrap_or(50)], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ---- accounts ----

#[tauri::command]
pub fn list_social_accounts(db: State<'_, Arc<Db>>) -> CmdResult<Vec<SocialAccount>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, platform, platform_user_id, display_name,
                    scopes_json, status, connected_at, token_expires_at
             FROM social_accounts ORDER BY platform, display_name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let scopes: String = r.get(4)?;
                Ok(SocialAccount {
                    id: r.get(0)?,
                    platform: r.get(1)?,
                    platform_user_id: r.get(2)?,
                    display_name: r.get(3)?,
                    scopes: serde_json::from_str(&scopes).unwrap_or_default(),
                    status: r.get(5)?,
                    connected_at: r.get(6)?,
                    token_expires_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Disconnect: delete vault credentials + mark revoked (row kept for
/// history; publish attempts stay auditable).
#[tauri::command]
pub fn disconnect_social_account(db: State<'_, Arc<Db>>, id: String) -> CmdResult<()> {
    let _ = super::vault::delete_tokens(&id); // vault may not exist — fine
    db.with(|conn| {
        conn.execute(
            "UPDATE social_accounts SET status='revoked' WHERE id=?1",
            [&id],
        )?;
        conn.execute(
            "UPDATE social_post_targets SET account_id=NULL
             WHERE account_id=?1 AND status NOT IN ('published','publishing')",
            [&id],
        )?;
        Ok(())
    })
}

/// Global history row: attempt + its post/target context.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub attempt_id: String,
    pub target_id: String,
    pub post_id: String,
    pub post_title: String,
    pub project_id: Option<String>,
    pub platform: String,
    pub account_id: Option<String>,
    pub status: String,
    pub platform_post_id: Option<String>,
    pub platform_url: Option<String>,
    pub error: Option<String>,
    pub attempt_no: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Global publication history across all posts. Filters: platform,
/// outcome ('ok'|'failed'|'uploading'|'cancelled'), since (ISO prefix),
/// limit. Never fabricates results — rows come verbatim from
/// publication_attempts.
#[tauri::command]
pub fn publication_history(
    db: State<'_, Arc<Db>>,
    platform: Option<String>,
    outcome: Option<String>,
    since: Option<String>,
    limit: Option<i64>,
) -> CmdResult<Vec<HistoryRow>> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT a.id, a.target_id, a.status, a.platform_post_id,
                    a.platform_url, a.error, a.attempt_no, a.started_at,
                    a.finished_at,
                    t.platform, t.account_id, p.id, p.title, p.project_id
             FROM publication_attempts a
             JOIN social_post_targets t ON t.id=a.target_id
             JOIN social_posts p ON p.id=t.post_id
             WHERE (?1 IS NULL OR t.platform=?1)
               AND (?2 IS NULL OR a.status=?2 OR
                    (?2='ok' AND a.status='published'))
               AND (?3 IS NULL OR a.started_at>=?3)
             ORDER BY a.started_at DESC LIMIT ?4",
        )?;
        let rows = stmt
            .query_map(
                params![
                    platform,
                    outcome,
                    since,
                    limit.unwrap_or(200).clamp(1, 1000)
                ],
                |r| {
                    Ok(HistoryRow {
                        attempt_id: r.get(0)?,
                        target_id: r.get(1)?,
                        status: r.get(2)?,
                        platform_post_id: r.get(3)?,
                        platform_url: r.get(4)?,
                        error: r.get(5)?,
                        attempt_no: r.get(6)?,
                        started_at: r.get(7)?,
                        finished_at: r.get(8)?,
                        platform: r.get(9)?,
                        account_id: r.get(10)?,
                        post_id: r.get(11)?,
                        post_title: r.get(12)?,
                        project_id: r.get(13)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ---- attempt history ----

#[tauri::command]
pub fn list_publication_attempts(
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> CmdResult<Vec<PublicationAttempt>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, target_id, status, platform_post_id, platform_url,
                    error, attempt_no, started_at, finished_at
             FROM publication_attempts WHERE target_id=?1
             ORDER BY started_at DESC",
        )?;
        let rows = stmt
            .query_map([target_id], |r| {
                Ok(PublicationAttempt {
                    id: r.get(0)?,
                    target_id: r.get(1)?,
                    status: r.get(2)?,
                    platform_post_id: r.get(3)?,
                    platform_url: r.get(4)?,
                    error: r.get(5)?,
                    attempt_no: r.get(6)?,
                    started_at: r.get(7)?,
                    finished_at: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Calendar query: all scheduled targets in a local-date range, joined
/// with post + platform for the card.
#[tauri::command]
pub fn list_scheduled(
    db: State<'_, Arc<Db>>,
    from: String,
    to: String,
) -> CmdResult<Vec<serde_json::Value>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.post_id, t.platform, t.scheduled_at, t.status,
                    t.auto_publish, p.title, t.export_asset_id, t.account_id
             FROM social_post_targets t JOIN social_posts p ON p.id=t.post_id
             WHERE t.scheduled_at IS NOT NULL
               AND t.scheduled_at >= ?1 AND t.scheduled_at <= ?2
             ORDER BY t.scheduled_at",
        )?;
        let rows = stmt
            .query_map(params![from, to], |r| {
                Ok(serde_json::json!({
                    "targetId": r.get::<_, String>(0)?,
                    "postId": r.get::<_, String>(1)?,
                    "platform": r.get::<_, String>(2)?,
                    "scheduledAt": r.get::<_, String>(3)?,
                    "status": r.get::<_, String>(4)?,
                    "autoPublish": r.get::<_, i64>(5)? != 0,
                    "title": r.get::<_, String>(6)?,
                    "exportAssetId": r.get::<_, Option<String>>(7)?,
                    "accountId": r.get::<_, Option<String>>(8)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

fn thumb_of(conn: &Connection, asset_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT thumbnail_path FROM media_assets WHERE id=?1",
        [asset_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|p| std::path::Path::new(p).is_file())
}

/// Preview image for a project: its own thumbnail, else the thumbnail of the
/// earliest clip that references a catalog asset.
fn project_preview(conn: &Connection, project_id: &str) -> Option<String> {
    let (file_path, thumb): (String, Option<String>) = conn
        .query_row(
            "SELECT file_path, thumbnail_path FROM projects WHERE id=?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()?;
    if let Some(t) = thumb.filter(|p| std::path::Path::new(p).is_file()) {
        return Some(t);
    }
    let doc = crate::project::store::open(std::path::Path::new(&file_path)).ok()?;
    let mut refs: Vec<(i64, &str)> = doc
        .timeline
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .filter_map(|c| c.media_ref.as_deref().map(|m| (c.start_ms, m)))
        .collect();
    refs.sort_by_key(|r| r.0);
    refs.into_iter().find_map(|(_, m)| thumb_of(conn, m))
}

/// post id → local image to show on its card. Order: the post's own
/// thumbnail, an exported file, then the linked project's first clip.
/// Posts with nothing resolvable are simply absent from the map.
#[tauri::command]
pub fn social_post_previews(
    db: State<'_, Arc<Db>>,
) -> CmdResult<std::collections::HashMap<String, String>> {
    db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, project_id, thumbnail_asset_id FROM social_posts")?;
        let posts = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = std::collections::HashMap::new();
        for (id, project_id, thumb_asset) in posts {
            let mut found = thumb_asset.as_deref().and_then(|a| thumb_of(conn, a));
            if found.is_none() {
                let mut s = conn.prepare(
                    "SELECT export_asset_id FROM social_post_targets
                     WHERE post_id=?1 AND export_asset_id IS NOT NULL",
                )?;
                let ids = s
                    .query_map([&id], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                found = ids.iter().find_map(|a| thumb_of(conn, a));
            }
            if found.is_none() {
                found = project_id.as_deref().and_then(|p| project_preview(conn, p));
            }
            if let Some(f) = found {
                out.insert(id, f);
            }
        }
        Ok(out)
    })
}

fn is_openable_url(u: &str) -> bool {
    (u.starts_with("https://") || u.starts_with("http://"))
        && !u.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Open a published post in the default browser. Only plain http(s) URLs
/// are accepted — never file paths or custom schemes.
#[tauri::command]
pub fn open_external_url(url: String) -> CmdResult<()> {
    let u = url.trim();
    if !is_openable_url(u) {
        return Err(AppError::InvalidInput(
            "only http(s) URLs can be opened".into(),
        ));
    }
    crate::proc_ext::open_url(u).map_err(|e| AppError::Internal(format!("open browser: {e}")))
}

/// Reveal a file in Explorer — used by "open location" everywhere.
#[tauri::command]
pub fn reveal_path(path: String) -> CmdResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::NotFound(format!("path {path}")));
    }
    #[cfg(windows)]
    {
        crate::proc_ext::silent("explorer")
            .arg("/select,")
            .arg(&p)
            .spawn()
            .map_err(AppError::from)?;
    }
    #[cfg(not(windows))]
    {
        if let Some(parent) = p.parent() {
            webbrowser::open(&parent.to_string_lossy())
                .map_err(|e| AppError::Internal(format!("open folder: {e}")))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("creatora-posts-{}", uuid::Uuid::new_v4()));
        (Db::open(&dir).unwrap(), dir)
    }

    fn target(platform: &str, scheduled: Option<&str>) -> TargetInput {
        TargetInput {
            platform: platform.into(),
            account_id: None,
            version_id: None,
            title: None,
            caption: None,
            hashtags: None,
            platform_meta: serde_json::json!({}),
            scheduled_at: scheduled.map(str::to_string),
            auto_publish: false,
        }
    }

    fn input(title: &str, targets: Vec<TargetInput>) -> PostInput {
        PostInput {
            project_id: None,
            title: title.into(),
            caption: String::new(),
            hashtags: vec![],
            thumbnail_asset_id: None,
            notes: None,
            targets,
        }
    }

    #[test]
    fn only_plain_http_urls_are_openable() {
        assert!(is_openable_url("https://youtu.be/abc"));
        assert!(is_openable_url("http://example.com/x?y=1"));
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            r"C:\Windows\notepad.exe",
            "ftp://x/y",
            "https://x/y z",
            "https://x/\nnext",
            "",
        ] {
            assert!(!is_openable_url(bad), "{bad}");
        }
    }

    #[test]
    fn status_transitions_never_rewrite_system_states() {
        assert_eq!(next_target_status(Some("published"), false), "published");
        assert_eq!(next_target_status(Some("published"), true), "published");
        assert_eq!(next_target_status(Some("publishing"), true), "publishing");
        assert_eq!(next_target_status(Some("ready"), false), "ready");
        assert_eq!(next_target_status(Some("ready"), true), "scheduled");
        assert_eq!(next_target_status(Some("failed"), false), "failed");
        assert_eq!(next_target_status(Some("failed"), true), "scheduled");
        assert_eq!(next_target_status(Some("scheduled"), false), "draft");
        assert_eq!(next_target_status(None, true), "scheduled");
        assert_eq!(next_target_status(None, false), "draft");
    }

    #[test]
    fn editing_a_published_target_keeps_it_published() {
        let (db, dir) = db();
        db.with(|c| {
            let p = save_post(c, None, &input("a", vec![target("youtube", None)]), false)?;
            c.execute(
                "UPDATE social_post_targets SET status='published',
                     platform_post_id='yt1', platform_url='https://y/1' WHERE id=?1",
                [&p.targets[0].id],
            )?;
            let again = save_post(
                c,
                Some(&p.id),
                &input("a2", vec![target("youtube", None)]),
                true,
            )?;
            assert_eq!(again.targets[0].status, "published");
            assert_eq!(again.targets[0].platform_post_id.as_deref(), Some("yt1"));
            assert_eq!(again.status, "published");
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removed_platforms_are_pruned_but_published_history_survives() {
        let (db, dir) = db();
        db.with(|c| {
            let p = save_post(
                c,
                None,
                &input(
                    "a",
                    vec![
                        target("youtube", None),
                        target("tiktok", None),
                        target("facebook", None),
                    ],
                ),
                false,
            )?;
            let fb = p.targets.iter().find(|t| t.platform == "facebook").unwrap();
            c.execute(
                "UPDATE social_post_targets SET status='published' WHERE id=?1",
                [&fb.id],
            )?;
            let again = save_post(
                c,
                Some(&p.id),
                &input("a", vec![target("youtube", None)]),
                false,
            )?;
            let mut left: Vec<_> = again.targets.iter().map(|t| t.platform.as_str()).collect();
            left.sort();
            assert_eq!(left, vec!["facebook", "youtube"]);
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_platform_inputs_collapse_to_one_target() {
        let (db, dir) = db();
        db.with(|c| {
            let p = save_post(
                c,
                None,
                &input("a", vec![target("youtube", None), target("youtube", None)]),
                false,
            )?;
            assert_eq!(p.targets.len(), 1);
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mark_ready_promotes_drafts_and_schedule_wins() {
        let (db, dir) = db();
        db.with(|c| {
            let p = save_post(
                c,
                None,
                &input(
                    "a",
                    vec![
                        target("youtube", None),
                        target("tiktok", Some("2026-12-01T10:00")),
                    ],
                ),
                true,
            )?;
            let st = |pl: &str| {
                p.targets
                    .iter()
                    .find(|t| t.platform == pl)
                    .unwrap()
                    .status
                    .clone()
            };
            assert_eq!(st("youtube"), "ready");
            assert_eq!(st("tiktok"), "scheduled");
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_save_rolls_back_everything() {
        let (db, dir) = db();
        db.with(|c| {
            let bad = input("a", vec![target("youtube", None), target("myspace", None)]);
            assert!(save_post(c, None, &bad, false).is_err());
            let n: i64 = c.query_row("SELECT COUNT(*) FROM social_posts", [], |r| r.get(0))?;
            assert_eq!(n, 0);
            // Missing post id must not leave stray targets either.
            assert!(save_post(
                c,
                Some("nope"),
                &input("a", vec![target("youtube", None)]),
                false
            )
            .is_err());
            let t: i64 =
                c.query_row("SELECT COUNT(*) FROM social_post_targets", [], |r| r.get(0))?;
            assert_eq!(t, 0);
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
