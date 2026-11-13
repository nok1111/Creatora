//! Audio analysis commands — job-based (waveform), direct (loudness,
//! silence: quick enough for a single clip but still async off-UI).

use crate::db::Db;
use crate::error::CmdResult;
use crate::jobs::{JobCtx, JobManager};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

fn waveforms_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("waveforms")
}

/// Waveform peaks — cached by (path, mtime, buckets). Runs as a job so the
/// UI stays responsive on long files; result persisted as JSON.
#[tauri::command]
pub fn generate_waveform(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    path: String,
    buckets: usize,
) -> CmdResult<Option<String>> {
    let key = {
        let m = std::fs::metadata(&path)
            .map(|m| (m.len(), m.modified().ok()))
            .unwrap_or((0, None));
        format!(
            "{:x}",
            xxhash_rust::xxh3::xxh3_64(format!("{path}:{m:?}:{buckets}").as_bytes())
        )
    };
    let cache = waveforms_dir(&app).join(format!("{key}.json"));
    if cache.is_file() {
        return Ok(None); // cache hit — read_waveform returns the data
    }
    let dir = waveforms_dir(&app);
    let job_id = jobs.spawn(app, "audio.waveform", move |ctx: &JobCtx| {
        ctx.progress(0.1, Some("Decoding audio"));
        let wf = super::waveform(std::path::Path::new(&path), buckets)?;
        if ctx.is_cancelled() {
            return Err("cancelled".into());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(
            &cache,
            serde_json::to_string(&wf).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        ctx.progress(1.0, None);
        serde_json::to_value(&wf).map_err(|e| e.to_string())
    });
    Ok(Some(job_id))
}

/// Read a cached waveform (after job completion or cache hit).
#[tauri::command]
pub fn read_waveform(
    app: AppHandle,
    path: String,
    buckets: usize,
) -> CmdResult<Option<super::Waveform>> {
    let key = {
        let m = std::fs::metadata(&path)
            .map(|m| (m.len(), m.modified().ok()))
            .unwrap_or((0, None));
        format!(
            "{:x}",
            xxhash_rust::xxh3::xxh3_64(format!("{path}:{m:?}:{buckets}").as_bytes())
        )
    };
    let cache = waveforms_dir(&app).join(format!("{key}.json"));
    if !cache.is_file() {
        return Ok(None);
    }
    let txt = std::fs::read_to_string(&cache)?;
    serde_json::from_str(&txt)
        .map(Some)
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))
}

/// EBU R128 loudness measurement — integrated LUFS / TP / LRA / threshold.
#[tauri::command]
pub fn analyze_loudness(_db: State<'_, Arc<Db>>, path: String) -> CmdResult<super::Loudness> {
    super::loudness(std::path::Path::new(&path)).map_err(Into::into)
}

/// Silence regions at the given threshold/min-duration — a PROPOSAL for
/// the UI to review; nothing is cut here.
#[tauri::command]
pub fn detect_silence(
    _db: State<'_, Arc<Db>>,
    path: String,
    noise_db: f64,
    min_ms: i64,
) -> CmdResult<Vec<super::SilenceRegion>> {
    super::detect_silence(std::path::Path::new(&path), noise_db, min_ms).map_err(Into::into)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeSuggestion {
    pub measured_lufs: f64,
    pub true_peak: f64,
    pub lra: f64,
    /// Linear gain to reach the target (apply to clip.volume — undoable).
    pub gain_db: f64,
    /// Post-gain peak would exceed this → suggest limiter clip fx.
    pub needs_limiter: bool,
}

/// Measure + suggest a non-destructive gain. `target_lufs` orientative
/// (presets in the UI: -14 YT, -16 podcast, … — never "required").
#[tauri::command]
pub fn suggest_normalize(
    _db: State<'_, Arc<Db>>,
    path: String,
    target_lufs: f64,
    tp_ceiling: f64,
) -> CmdResult<NormalizeSuggestion> {
    let l = super::loudness(std::path::Path::new(&path)).map_err(crate::error::AppError::from)?;
    let gain_db = super::gain_to_target(l.integrated, target_lufs);
    Ok(NormalizeSuggestion {
        measured_lufs: l.integrated,
        true_peak: l.true_peak,
        lra: l.lra,
        gain_db,
        needs_limiter: l.true_peak + gain_db > tp_ceiling,
    })
}
