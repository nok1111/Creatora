//! Job engine (ADR-009): every long task runs here — non-blocking, progress
//! events over `job://progress`, cancel via `job_cancel`, durable `jobs` table
//! rows for crash detection.

use crate::db::Db;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
}

impl JobCtx {
    pub fn progress(&self, fraction: f32, label: Option<&str>) {
        let _ = self.app.emit(
            EVT_PROGRESS,
            ProgressEvent {
                job_id: self.id.clone(),
                progress: fraction.clamp(-1.0, 1.0),
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

    fn record_start(&self, id: &str, kind: &str) {
        if let Some(db) = self.db.lock().as_ref() {
            let _ = db.with(|c| {
                c.execute(
                    "INSERT INTO jobs (id, kind, payload_json, status) VALUES (?1, ?2, '{}', 'running')",
                    [id, kind],
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
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs.lock().insert(
            id.clone(),
            JobEntry {
                cancel: cancel.clone(),
            },
        );
        self.record_start(&id, kind);

        let ctx = JobCtx {
            app: app.clone(),
            id: id.clone(),
            cancel,
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
                let _ = db.with(|c| {
                    c.execute(
                        "UPDATE jobs SET status = ?1, progress = 1.0,
                         finished_at = datetime('now') WHERE id = ?2",
                        [evt.status.as_str(), evt.job_id.as_str()],
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
