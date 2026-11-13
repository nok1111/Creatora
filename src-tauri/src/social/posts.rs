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
    let id = now_uuid();
    for t in &input.targets {
        if !valid_platform(&t.platform) {
            return Err(AppError::InvalidInput(format!(
                "unknown platform: {}",
                t.platform
            )));
        }
    }
    let hashtags = dedupe_hashtags(&input.hashtags);
    let auto_sched = input.targets.iter().any(|t| t.scheduled_at.is_some());
    db.with(|conn| {
        conn.execute(
            "INSERT INTO social_posts(id, project_id, title, caption,
                 hashtags_json, thumbnail_asset_id, notes, status)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                id,
                input.project_id,
                input.title,
                input.caption,
                serde_json::to_string(&hashtags).unwrap(),
                input.thumbnail_asset_id,
                input.notes,
                if auto_sched { "scheduled" } else { "draft" },
            ],
        )?;
        for t in &input.targets {
            let st = if t.scheduled_at.is_some() {
                "scheduled"
            } else {
                "draft"
            };
            conn.execute(
                &format!(
                    "INSERT INTO social_post_targets({TARGET_COLS})
                     VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,?10,?11,?12,
                            NULL,NULL,NULL,NULL)"
                ),
                params![
                    now_uuid(),
                    id,
                    t.platform,
                    t.account_id,
                    t.version_id,
                    t.title,
                    t.caption,
                    t.hashtags
                        .as_ref()
                        .map(|h| serde_json::to_string(&dedupe_hashtags(h)).unwrap()),
                    serde_json::to_string(&t.platform_meta).unwrap(),
                    st,
                    t.scheduled_at,
                    t.auto_publish as i64,
                ],
            )?;
            if let Some(hs) = &t.hashtags {
                record_hashtags(conn, hs)?;
            }
        }
        record_hashtags(conn, &hashtags)?;
        refresh_post_status(conn, &id)?;
        let mut p = get_post(conn, &id)?;
        p.targets = targets_of(conn, &id)?;
        Ok(p)
    })
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
    db.with(|conn| {
        // Upsert on (post_id, platform, version_id) — version NULL stored
        // as '' to make UNIQUE work in SQLite (NULLs never equal).
        let ver = input.version_id.clone().unwrap_or_default();
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM social_post_targets
                 WHERE post_id=?1 AND platform=?2
                   AND COALESCE(version_id,'')=?3",
                params![post_id, input.platform, ver],
                |r| r.get(0),
            )
            .ok();
        let status = if input.scheduled_at.is_some() {
            "scheduled"
        } else {
            "draft"
        };
        let tid = match existing {
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
        refresh_post_status(conn, &post_id)?;
        Ok(conn.query_row(
            &format!("SELECT {TARGET_COLS} FROM social_post_targets WHERE id=?1"),
            [&tid],
            row_to_target_pub,
        )?)
    })
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
        let post: String = conn
            .query_row(
                "SELECT post_id FROM social_post_targets WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound(format!("target {id}")))?;
        let status = if scheduled_at.is_some() {
            "scheduled"
        } else {
            "draft"
        };
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

/// Reveal a file in Explorer — used by "open location" everywhere.
#[tauri::command]
pub fn reveal_path(path: String) -> CmdResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::NotFound(format!("path {path}")));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
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
