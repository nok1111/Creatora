//! Publish path: real upload attempt → attempt log + target status.
//! A target becomes `published` ONLY when the adapter returned a real
//! platform id — every outcome lands in publication_attempts.

use super::model::SocialPost;
use super::platforms::PublishInput;
use super::vault;
use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::JobManager;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

/// Everything the worker thread needs, resolved before spawn.
struct Resolved {
    post: SocialPost,
    platform: String,
    file: Option<PathBuf>,
    account_id: Option<String>,
    meta: serde_json::Value,
    version_id: Option<String>,
}

fn resolve(db: &Arc<Db>, target_id: &str) -> Result<Resolved, AppError> {
    db.with(|conn| {
        let (post_id, platform, account_id, version_id, export_asset_id, meta_json) = conn
            .query_row(
                "SELECT post_id, platform, account_id, version_id,
                        export_asset_id, platform_meta_json
                 FROM social_post_targets WHERE id=?1",
                [target_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(|_| AppError::NotFound(format!("target {target_id}")))?;
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
        let file = match &export_asset_id {
            Some(aid) => Some(PathBuf::from(conn.query_row(
                "SELECT file_path FROM media_assets WHERE id=?1",
                [aid],
                |r| r.get::<_, String>(0),
            )?)),
            None => None,
        };
        Ok(Resolved {
            post,
            platform,
            file,
            account_id,
            meta: serde_json::from_str(&meta_json).unwrap_or(serde_json::json!({})),
            version_id,
        })
    })
}

fn attempt_no(db: &Arc<Db>, target_id: &str) -> i64 {
    db.with(|c| {
        c.query_row(
            "SELECT COALESCE(MAX(attempt_no),0)+1 FROM publication_attempts
             WHERE target_id=?1",
            [target_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })
    .unwrap_or(1)
}

/// Fire the real publish for a target. Returns the job id; the
/// `job://finished` result carries the PublishOutcome.
#[tauri::command]
pub fn publish_post_target(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    target_id: String,
) -> CmdResult<String> {
    let r = resolve(&db, &target_id)?;
    let account_id = r
        .account_id
        .clone()
        .ok_or_else(|| AppError::InvalidInput("no account connected".into()))?;

    // Load rules + client config before spawning — sync-fail fast.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    let ruleset = super::rules::load(&app_data);
    let rules = ruleset
        .platforms
        .get(&r.platform)
        .ok_or_else(|| AppError::InvalidInput("no rules".into()))?;
    if !rules.capabilities.publish {
        return Err(AppError::InvalidInput(format!(
            "{} publishing is not implemented — {}",
            r.platform, rules.capabilities.status_note
        )));
    }
    let client_id: String = db.with(|c| {
        c.query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("oauth_client_id.{}", r.platform)],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    let oauth = rules.oauth.clone();

    // Mark publishing + open the attempt row.
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let no = attempt_no(&db, &target_id);
    db.with(|conn| {
        conn.execute(
            "UPDATE social_post_targets SET status='publishing',
                 last_error=NULL, updated_at=datetime('now') WHERE id=?1",
            [&target_id],
        )?;
        conn.execute(
            "INSERT INTO publication_attempts(id, target_id, status, attempt_no)
             VALUES(?1,?2,'uploading',?3)",
            params![attempt_id, target_id, no],
        )?;
        Ok(())
    })?;

    let db2 = (*db).clone();
    let tid = target_id.clone();
    let platform = r.platform.clone();
    let input = PublishInput {
        file_path: r.file.clone(),
        title: r.post.title.clone(),
        description: r.post.caption.clone(),
        tags: r.post.hashtags.clone(),
        meta: r.meta.clone(),
        hosted_url: r
            .meta
            .get("hostedUrl")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    };
    let job_id = jobs.spawn(app.clone(), "social.publish", move |ctx| {
        // Any error path → mark attempt+target failed right here; the job
        // event only mirrors it. Never leaves a target stuck "publishing".
        let work = (|| -> Result<serde_json::Value, String> {
            // Refresh token if expired — refresh_if_needed persists on save.
            let token =
                super::oauth::refresh_if_needed(&db2, &account_id, &platform, &oauth, &client_id)?;
            let outcome = super::platforms::publish(
                &platform,
                &token,
                &input,
                &|sent, total| {
                    ctx.progress(
                        (sent as f32 / total.max(1) as f32).clamp(0.0, 1.0),
                        Some("Uploading"),
                    );
                },
                &|| ctx.is_cancelled(),
            )?;
            serde_json::to_value(&outcome).map_err(|e| e.to_string())
        })();
        let outcome_json = match work {
            Ok(v) => v,
            Err(e) => {
                let cancelled = ctx.is_cancelled() || e == "cancelled";
                let _ = mark_publish_failed(&db2, &tid, &e, cancelled);
                return Err(e);
            }
        };
        let outcome: super::platforms::PublishOutcome =
            serde_json::from_value(outcome_json.clone()).map_err(|e| e.to_string())?;
        // Only reach here on Ok — adapter errors already returned Err.
        let _ = db2.with(|conn| {
            conn.execute(
                "UPDATE social_post_targets SET status='published',
                     platform_post_id=?1, platform_url=?2,
                     published_at=datetime('now'), last_error=NULL,
                     updated_at=datetime('now') WHERE id=?3",
                params![outcome.platform_post_id, outcome.url, tid,],
            )?;
            conn.execute(
                "UPDATE publication_attempts SET status='published',
                     platform_post_id=?1, platform_url=?2,
                     finished_at=datetime('now') WHERE id=
                     (SELECT id FROM publication_attempts
                      WHERE target_id=?3 ORDER BY started_at DESC LIMIT 1)",
                params![outcome.platform_post_id, outcome.url, tid],
            )?;
            Ok(())
        });
        Ok(outcome_json)
    });

    // Store the job id on the attempt for cancel linkage.
    let _ = db.with(|conn| {
        conn.execute(
            "UPDATE publication_attempts SET job_id=?1 WHERE id=?2",
            params![job_id, attempt_id],
        )?;
        Ok(())
    });
    Ok(job_id)
}

/// Convert a failed job into a failed attempt + target — called by the
/// frontend's job listener, and by the scheduler's own watcher.
pub fn mark_publish_failed(
    db: &Arc<Db>,
    target_id: &str,
    error: &str,
    cancelled: bool,
) -> Result<(), AppError> {
    db.with(|conn| {
        conn.execute(
            "UPDATE social_post_targets SET status=?1, last_error=?2,
                 updated_at=datetime('now') WHERE id=?3",
            params![
                if cancelled { "cancelled" } else { "failed" },
                error,
                target_id
            ],
        )?;
        conn.execute(
            "UPDATE publication_attempts SET status=?1, error=?2,
                 finished_at=datetime('now') WHERE target_id=?3
               AND status='uploading'",
            params![
                if cancelled { "cancelled" } else { "failed" },
                error,
                target_id
            ],
        )?;
        // Roll the post status back up.
        let post_id: Option<String> = conn
            .query_row(
                "SELECT post_id FROM social_post_targets WHERE id=?1",
                [target_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(pid) = post_id {
            super::posts::refresh_post_status_pub(conn, &pid)?;
        }
        Ok(())
    })
}

// ---- export integration -----------------------------------------------

/// Export the post's project for ONE target (its version_id) into
/// `<exports>/<post-title>/<platform>.<container>`, then import the file
/// into the Library and link it to the target — one job, end to end.
#[tauri::command]
pub fn export_for_target(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    target_id: String,
    out_dir: String,
) -> CmdResult<String> {
    let r = resolve(&db, &target_id)?;
    let project_id = r
        .post
        .project_id
        .clone()
        .ok_or_else(|| AppError::InvalidInput("post has no project — link one first".into()))?;
    let project_path: String = db.with(|c| {
        c.query_row(
            "SELECT file_path FROM projects WHERE id=?1",
            [project_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::NotFound("project file".into()))
    })?;
    let slug = r.platform.clone();
    let out_path = PathBuf::from(&out_dir).join(format!("{slug}.mp4"));
    let version_id = r.version_id.clone();
    let tid = target_id.clone();
    let db2 = (*db).clone();
    let thumbs = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?
        .join("thumbnails");
    let job_id = jobs.spawn(app.clone(), "social.export", move |ctx| {
        let result = crate::render::commands::run_export_body(
            ctx,
            &std::path::PathBuf::from(&project_path),
            &out_path,
            version_id.as_deref(),
            &db2,
        )?;
        let out = PathBuf::from(result["outputPath"].as_str().unwrap_or_default());
        // Register the exported file in the Library (dedupes by path+hash).
        let asset = crate::media::commands::import_one(&thumbs, &db2, &out)
            .map_err(|e| format!("import export: {e}"))?;
        let _ = db2.with(|conn| {
            conn.execute(
                "UPDATE social_post_targets SET export_asset_id=?1,
                     status=CASE WHEN status='draft' THEN 'ready' ELSE status END,
                     updated_at=datetime('now') WHERE id=?2",
                rusqlite::params![asset.id, tid],
            )?;
            Ok(())
        });
        Ok(serde_json::json!({
            "export": result,
            "assetId": asset.id,
            "filePath": asset.file_path,
        }))
    });
    Ok(job_id)
}

// ---- capabilities + oauth client config --------------------------------

/// What every platform can REALLY do — feeds the honest UI badges.
#[tauri::command]
pub fn platform_capabilities(
    app: tauri::AppHandle,
) -> CmdResult<Vec<super::model::PlatformCapability>> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    let ruleset = super::rules::load(&app_data);
    Ok(ruleset
        .platforms
        .values()
        .map(|r| super::model::PlatformCapability {
            platform: r.platform.clone(),
            oauth: r.capabilities.oauth_loopback,
            publish: r.capabilities.publish,
            requires_app_review: r.capabilities.requires_app_review,
            requires_hosted_media: r.capabilities.requires_hosted_media,
            status_note: r.capabilities.status_note.clone(),
        })
        .collect())
}

/// Full ruleset for the UI (validation hints, duration caps shown to user).
#[tauri::command]
pub fn platform_ruleset(app: tauri::AppHandle) -> CmdResult<serde_json::Value> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    let r = super::rules::load(&app_data);
    serde_json::to_value(r).map_err(|e| AppError::Internal(e.to_string()))
}

/// Store the user's developer-app credentials. client_id → settings
/// (public); client_secret → OS vault (never SQLite/logs).
#[tauri::command]
pub fn save_oauth_client(
    db: State<'_, Arc<Db>>,
    platform: String,
    client_id: String,
    client_secret: Option<String>,
) -> CmdResult<()> {
    if client_id.trim().is_empty() {
        return Err(AppError::InvalidInput("client_id required".into()));
    }
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![format!("oauth_client_id.{platform}"), client_id.trim()],
        )?;
        Ok(())
    })?;
    if let Some(secret) = client_secret {
        if !secret.trim().is_empty() {
            vault::store_client_secret(&platform, secret.trim())?;
        }
    }
    Ok(())
}

/// Whether the user has configured a client id for a platform — the
/// connect button needs this before OAuth can start.
#[tauri::command]
pub fn oauth_client_status(db: State<'_, Arc<Db>>) -> CmdResult<serde_json::Value> {
    db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT key, value FROM settings WHERE key LIKE 'oauth_client_id.%'")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, !r.get::<_, String>(1)?.is_empty()))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut m = serde_json::Map::new();
        for p in super::model::PLATFORMS {
            m.insert(p.to_string(), serde_json::json!(false));
        }
        for (k, has) in rows {
            let p = k.trim_start_matches("oauth_client_id.");
            m.insert(p.to_string(), serde_json::json!(has));
        }
        Ok(serde_json::Value::Object(m))
    })
}
