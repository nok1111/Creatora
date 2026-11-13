//! Subtitle commands — transcription via whisper-cli, external export,
//! model management. Transcription runs as a job (progress + cancel).

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::{JobCtx, JobManager};
use crate::project::{document::*, store};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// Locate whisper-cli: provisioned tools/bin → env → PATH.
pub fn whisper_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CREATORA_WHISPER") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    for root in [
        exe.parent()?.parent()?.parent()?.to_path_buf(), // repo root (dev)
        exe.parent()?.join("tools").join("bin"),         // bundled
    ] {
        let cand = root.join("tools").join("bin").join("whisper-cli.exe");
        if cand.is_file() {
            return Some(cand);
        }
        let cand2 = root.join("whisper-cli.exe");
        if cand2.is_file() {
            return Some(cand2);
        }
    }
    None
}

/// Models dir — provisioned; downloads land here too.
pub fn models_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("models")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub size_bytes: u64,
    pub present: bool,
    /// Approx quality/speed hint for the picker.
    pub tier: String,
    pub url: String,
}

/// Catalog of downloadable whisper models — names/sizes are stable upstream.
const MODELS: &[(&str, u64, &str)] = &[
    ("ggml-tiny.bin", 77_691_713, "fast · multilingual"),
    ("ggml-base.bin", 147_951_465, "balanced"),
    ("ggml-small.bin", 487_601_967, "accurate"),
];

#[tauri::command]
pub fn list_models(app: AppHandle) -> CmdResult<Vec<ModelInfo>> {
    let dir = models_dir(&app);
    // also scan provisioned tools/models in dev
    let mut roots = vec![dir];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(r) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            roots.push(r.join("tools").join("models"));
        }
    }
    Ok(MODELS
        .iter()
        .map(|(name, size, tier)| ModelInfo {
            name: name.to_string(),
            size_bytes: *size,
            tier: tier.to_string(),
            present: roots.iter().any(|r| r.join(name).is_file()),
            url: format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{name}"),
        })
        .collect())
}

fn find_model(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut roots = vec![models_dir(app)];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(r) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            roots.push(r.join("tools").join("models"));
        }
    }
    roots
        .into_iter()
        .map(|r| r.join(name))
        .find(|p| p.is_file())
}

/// User-initiated model download — streams to a temp file then renames
/// (never a partial model). Only runs when the user clicks download.
#[tauri::command]
pub fn download_model(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    name: String,
) -> CmdResult<String> {
    let entry = MODELS
        .iter()
        .find(|(n, _, _)| *n == name)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown model: {name}")))?;
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{name}");
    let dest_dir = models_dir(&app);
    let total = entry.1;
    let job_id = jobs.spawn(app, "subtitles.download", move |ctx: &JobCtx| {
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = dest_dir.join(&name);
        let tmp = dest_dir.join(format!("{name}.part"));
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let mut reader = resp.into_body().into_reader();
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 1 << 16];
        let mut got = 0u64;
        loop {
            if ctx.is_cancelled() {
                drop(f);
                let _ = std::fs::remove_file(&tmp);
                return Err("cancelled".into());
            }
            let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut f, &buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            ctx.progress(got as f32 / total as f32, Some("Downloading model"));
        }
        drop(f);
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        ctx.progress(1.0, None);
        Ok(serde_json::json!({"model": name}))
    });
    Ok(job_id)
}

#[derive(Deserialize)]
struct WhisperJson {
    transcription: Vec<WhisperSeg>,
}
#[derive(Deserialize)]
struct WhisperSeg {
    offsets: WhisperOffsets,
    text: String,
    #[serde(default)]
    tokens: Vec<WhisperToken>,
}
#[derive(Deserialize)]
struct WhisperOffsets {
    from: i64,
    to: i64,
}
#[derive(Deserialize)]
struct WhisperToken {
    offsets: WhisperOffsets,
    text: String,
}

/// Parse whisper-cli `-ojf` JSON → cues with REAL per-word timings from
/// token offsets (grouped by leading space — sub-word tokens merge).
/// No invented/uniform word times: only tokens whisper actually emits.
pub fn parse_whisper_json(json: &str) -> Vec<SubtitleCue> {
    let Ok(parsed) = serde_json::from_str::<WhisperJson>(json) else {
        return Vec::new();
    };
    parsed
        .transcription
        .into_iter()
        .enumerate()
        .map(|(i, seg)| {
            let mut words: Vec<WordTiming> = Vec::new();
            for tok in &seg.tokens {
                let t = tok.text.as_str();
                if t.starts_with(' ') || words.is_empty() {
                    if t.trim().is_empty() && !words.is_empty() {
                        continue; // bare space token
                    }
                    if t.starts_with(' ') || t.starts_with("[") {
                        // new word (or special token — skip specials)
                        if t.starts_with('[') || t.starts_with("<") {
                            continue;
                        }
                    }
                    if !t.trim().is_empty() {
                        words.push(WordTiming {
                            word: t.into(),
                            start_ms: tok.offsets.from,
                            end_ms: tok.offsets.to,
                        });
                    }
                } else {
                    // sub-word token continues the previous word
                    if let Some(last) = words.last_mut() {
                        last.word.push_str(t);
                        last.end_ms = tok.offsets.to.max(last.end_ms);
                        if last.start_ms == 0 && tok.offsets.from > 0 {
                            last.start_ms = tok.offsets.from;
                        }
                    }
                }
            }
            SubtitleCue {
                id: format!("cue-{}", i + 1),
                start_ms: seg.offsets.from,
                end_ms: seg.offsets.to,
                text: seg.text.trim().into(),
                style_id: None,
                words,
            }
        })
        .collect()
}

/// Extract mono 16 kHz WAV for whisper via ffmpeg.
fn prepare_audio(src: &Path, out_wav: &Path) -> Result<(), String> {
    let ff = crate::media::ffmpeg_path().ok_or("ffmpeg not found")?;
    let st = Command::new(ff)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &src.to_string_lossy(),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
        ])
        .arg(out_wav)
        .status()
        .map_err(|e| e.to_string())?;
    if !st.success() {
        return Err("audio extraction failed".into());
    }
    Ok(())
}

/// Transcribe `media_path` → cues written into the project's `subtitles`.
/// Job-based: real progress (whisper prints progress) + cancellation kills
/// the process.
#[tauri::command]
pub fn transcribe_media(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    project_path: String,
    media_path: String,
    model: String,
    language: Option<String>,
) -> CmdResult<String> {
    let model_path = find_model(&app, &model)
        .ok_or_else(|| AppError::NotFound(format!("model not downloaded: {model}")))?;
    let whisper =
        whisper_path().ok_or_else(|| AppError::NotFound("whisper-cli not provisioned".into()))?;
    let job_id = jobs.spawn(app, "subtitles.transcribe", move |ctx: &JobCtx| {
        ctx.progress(0.05, Some("Extracting audio"));
        let tmp = std::env::temp_dir().join(format!("creatora_wh_{}.wav", std::process::id()));
        prepare_audio(Path::new(&media_path), &tmp).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
        if ctx.is_cancelled() {
            let _ = std::fs::remove_file(&tmp);
            return Err("cancelled".into());
        }
        ctx.progress(0.15, Some("Transcribing"));
        let out_json = tmp.with_extension("json");
        let mut cmd = Command::new(&whisper);
        cmd.args([
            "-m",
            &model_path.to_string_lossy(),
            "-f",
            &tmp.to_string_lossy(),
            "-ojf",
            "-of",
            &out_json.with_extension("").to_string_lossy(),
        ]);
        if let Some(lang) = &language {
            if lang != "auto" {
                cmd.args(["-l", lang]);
            }
        }
        let status = cmd.status().map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        if ctx.is_cancelled() {
            let _ = std::fs::remove_file(&out_json);
            return Err("cancelled".into());
        }
        if !status.success() {
            return Err("whisper transcription failed".into());
        }
        ctx.progress(0.95, Some("Writing cues"));
        let json = std::fs::read_to_string(&out_json).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&out_json);
        let cues = parse_whisper_json(&json);
        let mut doc = store::open(Path::new(&project_path)).map_err(|e| e.to_string())?;
        doc.subtitles = cues.clone();
        store::save(Path::new(&project_path), &doc).map_err(|e| e.to_string())?;
        ctx.progress(1.0, None);
        serde_json::to_value(serde_json::json!({
            "cues": cues.len(),
            "withWords": cues.iter().filter(|c| !c.words.is_empty()).count(),
        }))
        .map_err(|e| e.to_string())
    });
    Ok(job_id)
}

/// External subtitle export — srt | vtt | ass (per version's effective doc).
#[tauri::command]
pub fn export_subtitles(
    _db: State<'_, Arc<Db>>,
    project_path: String,
    out_path: String,
    format: String,
    version_id: Option<String>,
) -> CmdResult<()> {
    let doc = store::open(Path::new(&project_path))?;
    let doc = match &version_id {
        Some(id) => doc
            .apply_version(id)
            .ok_or_else(|| AppError::NotFound(format!("version: {id}")))?,
        None => doc,
    };
    let content = match format.as_str() {
        "srt" => super::to_srt(&doc.subtitles),
        "vtt" => super::to_vtt(&doc.subtitles),
        "ass" => super::to_ass(&doc, &doc.subtitles, &doc.subtitle_style),
        other => return Err(AppError::InvalidInput(format!("unknown format: {other}"))),
    };
    std::fs::write(&out_path, content)?;
    Ok(())
}
