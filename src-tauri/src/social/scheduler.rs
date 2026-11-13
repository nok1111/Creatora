//! Local scheduler: every minute, find due scheduled targets.
//!
//! Semantics are honest by construction:
//!  - auto_publish=1 + connected account + linked file → real publish job
//!  - otherwise → `social://due` reminder event. A reminder NEVER marks
//!    anything published; it only nags the user to publish manually.
//!
//! The scheduler runs only while the app is open — it's a desktop
//! reminder/queue, not a server cron (documented in the UI + guide).

use crate::db::Db;
use crate::jobs::JobManager;
use crate::social::validate::now_unix;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const DUE_EVENT: &str = "social://due";
const TICK_SECS: u64 = 60;

/// Spawn the background tick. Runs for the app lifetime.
pub fn start(app: AppHandle, db: Arc<Db>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
        if let Err(e) = tick(&app, &db) {
            log::warn!("social scheduler tick: {e}");
        }
    });
}

pub struct Due {
    pub target_id: String,
    pub post_id: String,
    pub platform: String,
    pub auto_publish: bool,
    pub account_id: Option<String>,
    pub export_asset_id: Option<String>,
    pub title: String,
}

pub fn due_targets(db: &Arc<Db>, now: i64) -> Result<Vec<Due>, crate::error::AppError> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.post_id, t.platform, t.auto_publish,
                    t.account_id, t.export_asset_id, p.title, t.scheduled_at
             FROM social_post_targets t JOIN social_posts p ON p.id = t.post_id
             WHERE t.status = 'scheduled' AND t.scheduled_at IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)? != 0,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|r| {
                crate::social::validate::chrono_free_parse(&r.7)
                    .map(|t| t <= now)
                    .unwrap_or(false)
            })
            .map(|r| Due {
                target_id: r.0,
                post_id: r.1,
                platform: r.2,
                auto_publish: r.3,
                account_id: r.4,
                export_asset_id: r.5,
                title: r.6,
            })
            .collect())
    })
}

fn tick(app: &AppHandle, db: &Arc<Db>) -> Result<(), crate::error::AppError> {
    let due = due_targets(db, now_unix())?;
    for d in due {
        let can_auto = d.auto_publish && d.account_id.is_some() && d.export_asset_id.is_some();
        if can_auto {
            // Real publish attempt — reuses the same command path so the
            // attempt log, status transitions and errors are identical
            // to a manual publish.
            log::info!("auto-publishing scheduled target {}", d.target_id);
            let jobs_state = tauri::Manager::state::<JobManager>(app);
            let db_state = tauri::Manager::state::<Arc<Db>>(app);
            match super::publish::publish_post_target(
                app.clone(),
                jobs_state,
                db_state,
                d.target_id.clone(),
            ) {
                Ok(job) => log::info!("scheduled publish job {job}"),
                Err(e) => {
                    let _ = super::publish::mark_publish_failed(
                        db,
                        &d.target_id,
                        &e.to_string(),
                        false,
                    );
                }
            }
        } else {
            // Reminder only — flip to failed? No: keep 'scheduled' so the
            // card stays visible, just emit the event. Frontend shows a
            // toast "post is due — publish manually".
            let _ = app.emit(
                DUE_EVENT,
                serde_json::json!({
                    "targetId": d.target_id,
                    "postId": d.post_id,
                    "platform": d.platform,
                    "title": d.title,
                    "reason": if !d.auto_publish {
                        "auto_publish_off"
                    } else if d.account_id.is_none() {
                        "no_account"
                    } else {
                        "no_export"
                    },
                }),
            );
        }
    }
    // Phase 9: due analytics sync (no-op when interval = 0).
    let jobs_state = tauri::Manager::state::<JobManager>(app);
    super::analytics::maybe_run_due(app, &jobs_state, db);
    Ok(())
}
