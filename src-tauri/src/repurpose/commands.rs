//! `repurpose_analyze` — one job: transcript (cached) → audio energy →
//! clip candidates.

use super::candidates::{pick_candidates, Candidate, Energy, Params};
use crate::error::{AppError, CmdResult};
use crate::jobs::{JobCtx, JobManager};
use crate::project::document::SubtitleCue;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// Seconds-resolution energy: fine enough for 15 s+ clips, tiny payload.
const ENERGY_BUCKET_MS: i64 = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeOpts {
    pub path: String,
    pub model: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(flatten)]
    pub params: Params,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeResult {
    duration_ms: i64,
    cues: Vec<SubtitleCue>,
    candidates: Vec<Candidate>,
    /// Transcript came from the on-disk cache (no whisper run).
    cached: bool,
    has_energy: bool,
    /// Source frame rate (capped at 60) so generated projects keep it.
    fps_num: u32,
    fps_den: u32,
}

/// Source fps as a clean fraction, capped at 60 (30/1 when unknown).
pub(crate) fn clean_fps(num: Option<u32>, den: Option<u32>) -> (u32, u32) {
    match (num, den) {
        (Some(n), Some(d)) if n > 0 && d > 0 => {
            let f = n as f64 / d as f64;
            if f > 60.5 {
                (60, 1)
            } else if (f - f.round()).abs() < 0.02 {
                (f.round() as u32, 1)
            } else {
                (n, d)
            }
        }
        _ => (30, 1),
    }
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("repurpose"))
}

/// Cache key: source identity (path + size + mtime) + model + language.
fn cache_key(path: &Path, model: &str, language: Option<&str>) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = Sha256::new();
    h.update(path.to_string_lossy().as_bytes());
    h.update(meta.len().to_le_bytes());
    h.update(mtime.to_le_bytes());
    h.update(model.as_bytes());
    h.update(language.unwrap_or("auto").as_bytes());
    Some(format!("{:x}", h.finalize())[..24].to_string())
}

/// Per-bucket amplitude from waveform peaks, normalised by the 90th
/// percentile so "loud for this speaker" ≈ 1. None when the track is silent.
fn energy_envelope(path: &Path) -> Option<(Vec<f32>, i64)> {
    let dur_hint = crate::media::probe::probe(path).ok()?.duration_ms? as f64;
    let buckets = ((dur_hint / ENERGY_BUCKET_MS as f64).ceil() as usize).clamp(16, 64_000);
    let wf = crate::audio::waveform(path, buckets).ok()?;
    let amps: Vec<f32> = wf
        .peaks
        .chunks(2)
        .map(|p| ((p.get(1).copied().unwrap_or(0.0) - p[0]).abs()) / 2.0)
        .collect();
    let mut sorted: Vec<f32> = amps.iter().copied().filter(|a| *a > 1e-4).collect();
    if sorted.len() < 8 {
        return None;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p90 = sorted[(sorted.len() as f64 * 0.9) as usize % sorted.len()].max(1e-4);
    let bucket_ms = (wf.duration_ms.max(1) as f64 / amps.len() as f64).round() as i64;
    Some((
        amps.iter().map(|a| (a / p90).min(1.0)).collect(),
        bucket_ms.max(1),
    ))
}

/// Analyze a source video → ranked clip suggestions. Job `repurpose.analyze`;
/// the finished payload is an `AnalyzeResult`.
#[tauri::command]
pub fn repurpose_analyze(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    opts: AnalyzeOpts,
) -> CmdResult<String> {
    let p = opts.params;
    if p.min_ms < 5_000 || p.max_ms < p.min_ms || p.ideal_ms < p.min_ms || p.ideal_ms > p.max_ms {
        return Err(AppError::InvalidInput("invalid clip length range".into()));
    }
    if !(1..=20).contains(&p.count) {
        return Err(AppError::InvalidInput("count must be 1–20".into()));
    }
    if !Path::new(&opts.path).is_file() {
        return Err(AppError::NotFound(format!("source {}", opts.path)));
    }
    // Fail fast with a clear reason instead of a mid-job ffmpeg error.
    let info = crate::media::probe::probe(Path::new(&opts.path))?;
    if !info.has_audio {
        return Err(AppError::InvalidInput("no_audio".into()));
    }
    let (fps_num, fps_den) = clean_fps(info.fps_num, info.fps_den);
    let model_path = crate::subtitles::commands::find_model(&app, &opts.model)?
        .ok_or_else(|| AppError::NotFound(format!("model not downloaded: {}", opts.model)))?;
    let whisper = crate::subtitles::commands::whisper_path()
        .ok_or_else(|| AppError::NotFound("whisper-cli not provisioned".into()))?;
    let payload = serde_json::json!({ "path": opts.path, "model": opts.model });

    let job_id = jobs.spawn_with_payload(
        app.clone(),
        "repurpose.analyze",
        &payload,
        move |ctx: &JobCtx| {
            let src = PathBuf::from(&opts.path);
            let lang = opts.language.as_deref().filter(|l| *l != "auto");
            let dir = cache_dir(&app)?;
            let key = cache_key(&src, &opts.model, lang);
            let cache_file = key.as_ref().map(|k| dir.join(format!("{k}.json")));

            let cached_cues: Option<Vec<SubtitleCue>> = cache_file
                .as_ref()
                .and_then(|f| std::fs::read_to_string(f).ok())
                .and_then(|s| serde_json::from_str(&s).ok());
            let cached = cached_cues.is_some();
            let cues = match cached_cues {
                Some(c) => {
                    ctx.progress(0.7, Some("Using saved transcript"));
                    c
                }
                None => {
                    let c = crate::subtitles::commands::transcribe_to_cues(
                        ctx,
                        &whisper,
                        &model_path,
                        &src,
                        lang,
                        (0.02, 0.8),
                    )?;
                    if let Some(f) = &cache_file {
                        let _ = std::fs::create_dir_all(&dir);
                        if let Ok(s) = serde_json::to_string(&c) {
                            let _ = std::fs::write(f, s);
                        }
                    }
                    c
                }
            };
            if ctx.is_cancelled() {
                return Err("cancelled".into());
            }

            ctx.progress(0.85, Some("Measuring audio energy"));
            let energy = energy_envelope(&src);
            let duration_ms = crate::media::probe::probe(&src)
                .ok()
                .and_then(|m| m.duration_ms)
                .unwrap_or_else(|| cues.last().map(|c| c.end_ms).unwrap_or(0));

            ctx.progress(0.95, Some("Ranking clips"));
            let candidates = pick_candidates(
                &cues,
                energy.as_ref().map(|(v, b)| Energy {
                    bucket_ms: *b,
                    values: v,
                }),
                p,
            );
            ctx.progress(1.0, None);
            serde_json::to_value(AnalyzeResult {
                duration_ms,
                cues,
                candidates,
                cached,
                has_energy: energy.is_some(),
                fps_num,
                fps_den,
            })
            .map_err(|e| e.to_string())
        },
    );
    Ok(job_id)
}

#[cfg(test)]
mod tests {
    use super::clean_fps;

    #[test]
    fn fps_is_cleaned_and_capped() {
        assert_eq!(clean_fps(Some(30), Some(1)), (30, 1));
        assert_eq!(clean_fps(Some(30000), Some(1001)), (30000, 1001)); // 29.97 stays exact
        assert_eq!(clean_fps(Some(120), Some(1)), (60, 1));
        assert_eq!(clean_fps(Some(25), Some(1)), (25, 1));
        assert_eq!(clean_fps(None, Some(1)), (30, 1));
        assert_eq!(clean_fps(Some(0), Some(1)), (30, 1));
    }
}
