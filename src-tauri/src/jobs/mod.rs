//! Job engine (ADR-009): every long task runs here — non-blocking, progress
//! events over `job://progress`, cancel via `job_cancel`, durable `jobs` table
//! rows for crash detection.

use crate::db::Db;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::Emitter;

pub const EVT_PROGRESS: &str = "job://progress";
pub const EVT_FINISHED: &str = "job://finished";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub job_id: String,
    /// 0.0–1.0; -1 = indeterminate.
    pub progress: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedEvent {
    pub job_id: String,
    /// done | failed | cancelled
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct JobEntry {
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct JobManager {
    /// Shared so spawned workers can drop their own entry on finish —
    /// the map never grows unboundedly.
    jobs: Arc<Mutex<HashMap<String, JobEntry>>>,
    /// Attached at setup so spawns record a durable row in `jobs` —
    /// interrupted jobs are detectable on next launch.
    db: Mutex<Option<Arc<Db>>>,
}

/// Handle passed to job bodies: report progress, observe cancellation.
pub struct JobCtx {
    app: tauri::AppHandle,
    id: String,
    cancel: Arc<AtomicBool>,
    /// Last reported fraction — persisted on finish so the durable row
    /// shows where a failed/cancelled job actually stopped (no per-event
    /// DB writes needed).
    last_progress: Arc<AtomicU32>,
}

impl JobCtx {
    pub fn progress(&self, fraction: f32, label: Option<&str>) {
        let p = fraction.clamp(-1.0, 1.0);
        self.last_progress.store(p.to_bits(), Ordering::Relaxed);
        let _ = self.app.emit(
            EVT_PROGRESS,
            ProgressEvent {
                job_id: self.id.clone(),
                progress: p,
                label: label.map(str::to_string),
            },
        );
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl JobManager {
    pub fn attach_db(&self, db: Arc<Db>) {
        *self.db.lock() = Some(db);
    }

    /// Mark jobs left 'running' by a crash/kill as 'interrupted' so the UI
    /// never shows phantom work. Called once at startup.
    pub fn sweep_interrupted(&self) {
        if let Some(db) = self.db.lock().as_ref() {
            let _ = db.with(|c| {
                c.execute(
                    "UPDATE jobs SET status = 'interrupted', finished_at = datetime('now')
                     WHERE status = 'running'",
                    [],
                )?;
                Ok(())
            });
        }
    }

    fn record_start(&self, id: &str, kind: &str, payload: &serde_json::Value) {
        let pj = serde_json::to_string(payload).unwrap_or_else(|_| "{}".into());
        if let Some(db) = self.db.lock().as_ref() {
            let _ = db.with(|c| {
                c.execute(
                    "INSERT INTO jobs (id, kind, payload_json, status) VALUES (?1, ?2, ?3, 'running')",
                    rusqlite::params![id, kind, pj],
                )?;
                Ok(())
            });
        }
    }

    /// Spawn `body` on the async runtime. Returns the job id immediately.
    /// `body` runs on a blocking thread — safe for ffprobe/IO loops.
    pub fn spawn<F>(&self, app: tauri::AppHandle, kind: &str, body: F) -> String
    where
        F: FnOnce(&JobCtx) -> Result<serde_json::Value, String> + Send + 'static,
    {
        self.spawn_with_payload(app, kind, &serde_json::json!({}), body)
    }

    /// Spawn with a durable metadata payload (project name, output,
    /// destination…) so the Export Center can render a useful history.
    pub fn spawn_with_payload<F>(
        &self,
        app: tauri::AppHandle,
        kind: &str,
        payload: &serde_json::Value,
        body: F,
    ) -> String
    where
        F: FnOnce(&JobCtx) -> Result<serde_json::Value, String> + Send + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let last_progress = Arc::new(AtomicU32::new(0f32.to_bits()));
        self.jobs.lock().insert(
            id.clone(),
            JobEntry {
                cancel: cancel.clone(),
            },
        );
        self.record_start(&id, kind, payload);

        let ctx = JobCtx {
            app: app.clone(),
            id: id.clone(),
            cancel,
            last_progress: last_progress.clone(),
        };
        let app2 = app.clone();
        let id2 = id.clone();
        let jm_db = self.db.lock().clone();
        let jobs = self.jobs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let evt = match body(&ctx) {
                Ok(result) => FinishedEvent {
                    job_id: id2.clone(),
                    status: "done".into(),
                    result: Some(result),
                    error: None,
                },
                Err(e) if ctx.is_cancelled() => FinishedEvent {
                    job_id: id2.clone(),
                    status: "cancelled".into(),
                    result: None,
                    error: Some(e),
                },
                Err(e) => FinishedEvent {
                    job_id: id2.clone(),
                    status: "failed".into(),
                    result: None,
                    error: Some(e),
                },
            };
            if let Some(db) = jm_db {
                // Honest final progress: 1.0 only when the job actually
                // completed; failed/cancelled rows keep where they stopped.
                let final_p = if evt.status == "done" {
                    1.0f32
                } else {
                    f32::from_bits(last_progress.load(Ordering::Relaxed))
                        .clamp(0.0, 1.0)
                };
                let _ = db.with(|c| {
                    c.execute(
                        "UPDATE jobs SET status = ?1, progress = ?2, error = ?3,
                         finished_at = datetime('now') WHERE id = ?4",
                        rusqlite::params![
                            evt.status.as_str(),
                            final_p as f64,
                            evt.error.as_deref(),
                            evt.job_id.as_str()
                        ],
                    )?;
                    Ok(())
                });
            }
            let _ = app2.emit(EVT_FINISHED, evt);
            jobs.lock().remove(&id2);
        });

        log::info!("job {id} spawned ({kind})");
        id
    }

    /// List durable job rows — powers the Export Center / activity views.
    /// `kind_prefix` filters with LIKE '<prefix>%'; None lists everything.
    pub fn list(&self, kind_prefix: Option<&str>, limit: i64) -> Vec<serde_json::Value> {
        let Some(db) = self.db.lock().clone() else {
            return Vec::new();
        };
        db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, kind, payload_json, status, progress, created_at, finished_at, error
                 FROM jobs
                 WHERE (?1 IS NULL OR kind LIKE ?1 || '%')
                 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![kind_prefix, limit], |r| {
                let pj: String = r.get(2)?;
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "payload": serde_json::from_str::<serde_json::Value>(&pj)
                        .unwrap_or(serde_json::json!({})),
                    "status": r.get::<_, String>(3)?,
                    "progress": r.get::<_, f64>(4)?,
                    "createdAt": r.get::<_, String>(5)?,
                    "finishedAt": r.get::<_, Option<String>>(6)?,
                    "error": r.get::<_, Option<String>>(7)?,
                }))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
        })
        .unwrap_or_default()
    }

    /// Signal cancellation. Returns false for unknown/finished jobs.
    pub fn cancel(&self, id: &str) -> bool {
        if let Some(entry) = self.jobs.lock().get(id) {
            entry.cancel.store(true, Ordering::Relaxed);
            log::info!("job {id} cancel requested");
            true
        } else {
            false
        }
    }
}
