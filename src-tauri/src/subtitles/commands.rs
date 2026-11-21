//! Subtitle commands — transcription via whisper-cli, external export,
//! model management. Transcription runs as a job (progress + cancel).

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::{JobCtx, JobManager};
use crate::project::{document::*, store};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// Locate whisper-cli: bundled tools/bin next to the exe, repo tools/bin in
/// dev builds, CREATORA_WHISPER env override, then PATH — same scheme as
/// `media::tool_path` but with a plain file check (whisper-cli doesn't
/// guarantee a `-version` flag).
pub fn whisper_path() -> Option<PathBuf> {
    let exe_name = "whisper-cli.exe";
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("CREATORA_WHISPER") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(dir.join("tools").join("bin").join(exe_name));
        candidates.push(dir.join(exe_name));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../tools/bin")
                .join(exe_name),
        );
    }
    candidates.push(PathBuf::from("whisper-cli")); // PATH
    candidates
        .into_iter()
        .find(|p| p.is_file() || p.components().count() == 1)
}

/// Models dir — provisioned; downloads land here too.
pub fn models_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("models"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub size_bytes: u64,
    pub present: bool,
    /// Bytes already on disk in `<name>.part` — a download that was
    /// cancelled/interrupted and can be resumed with a Range request.
    pub partial_bytes: u64,
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

/// Tools/models dir for dev builds — shares the repo-root logic used by
/// list_models/find_model (CARGO_MANIFEST_DIR = src-tauri → repo root one up).
fn dev_models_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/models"))
    } else {
        // Bundled layout: models live next to the exe under tools/models.
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("tools").join("models")))
    }
}

#[tauri::command]
pub fn list_models(app: AppHandle) -> CmdResult<Vec<ModelInfo>> {
    let dir = models_dir(&app)?;
    // also scan provisioned tools/models in dev
    let mut roots = vec![dir];
    if let Some(r) = dev_models_root() {
        roots.push(r);
    }
    let part_len = |name: &str| -> u64 {
        roots
            .iter()
            .filter_map(|r| {
                std::fs::metadata(r.join(format!("{name}.part")))
                    .ok()
                    .map(|m| m.len())
            })
            .max()
            .unwrap_or(0)
    };
    Ok(MODELS
        .iter()
        .map(|(name, size, tier)| ModelInfo {
            name: name.to_string(),
            size_bytes: *size,
            present: roots.iter().any(|r| r.join(name).is_file()),
            partial_bytes: if roots.iter().any(|r| r.join(name).is_file()) {
                0
            } else {
                part_len(name)
            },
            tier: tier.to_string(),
            url: format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{name}"),
        })
        .collect())
}

pub(crate) fn find_model(app: &AppHandle, name: &str) -> CmdResult<Option<PathBuf>> {
    let mut roots = vec![models_dir(app)?];
    if let Some(r) = dev_models_root() {
        roots.push(r);
    }
    Ok(roots
        .into_iter()
        .map(|r| r.join(name))
        .find(|p| p.is_file()))
}

/// User-initiated model download — streams to `<name>.part` then renames
/// (never installs a partial model). Resumes an existing `.part` with an
/// HTTP Range request, so a cancelled/interrupted download continues where
/// it stopped. Integrity is validated before install: exact size match
/// against the known-good catalog entry + the ggml magic header.
/// Only runs when the user clicks download — never automatic.
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
    let dest_dir = models_dir(&app)?;
    let total = entry.1;
    let job_id = jobs.spawn(app, "subtitles.download", move |ctx: &JobCtx| {
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = dest_dir.join(&name);
        let tmp = dest_dir.join(format!("{name}.part"));

        // Resume point: keep a sane `.part`, drop oversized/corrupt ones.
        let mut got = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        if got >= total {
            let _ = std::fs::remove_file(&tmp);
            got = 0;
        }

        let mut req = ureq::get(&url);
        if got > 0 {
            req = req.header("Range", format!("bytes={got}-"));
        }
        let resp = req.call().map_err(|e| e.to_string())?;
        let resuming = got > 0 && resp.status() == 206;
        if got > 0 && !resuming {
            // Server ignored the range — restart from zero.
            got = 0;
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(!resuming)
            .append(resuming)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        let mut reader = resp.into_body().into_reader();
        let mut buf = [0u8; 1 << 16];
        loop {
            if ctx.is_cancelled() {
                drop(f);
                // Keep `.part` — the next download resumes from here.
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

        // Integrity gate: exact expected size + ggml magic before install.
        // The header is the LE u32 0x67676d6c → bytes "lmgg" on disk.
        let len = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        let magic_ok = std::fs::File::open(&tmp)
            .and_then(|mut r| {
                let mut m = [0u8; 4];
                std::io::Read::read_exact(&mut r, &mut m).map(|_| m)
            })
            .map(|m| u32::from_le_bytes(m) == 0x6767_6d6c)
            .unwrap_or(false);
        if len != total || !magic_ok {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!(
                "model download failed integrity check (got {len} bytes, expected {total})"
            ));
        }

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
    let st = crate::proc_ext::silent(ff)
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

/// "whisper_print_progress_callback: progress =  42%" → 42.
fn parse_progress(line: &str) -> Option<u32> {
    line.split("progress =")
        .nth(1)?
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse()
        .ok()
}

/// Run whisper over `media_path` and return cues with real word timings.
/// `span` maps the work onto `ctx` progress (lo..hi) so callers can embed it
/// in a longer job. Cancellation kills nothing mid-run (whisper-cli runs to
/// completion) but is honoured before and after.
pub(crate) fn transcribe_to_cues(
    ctx: &JobCtx,
    whisper: &Path,
    model_path: &Path,
    media_path: &Path,
    language: Option<&str>,
    span: (f32, f32),
) -> Result<Vec<SubtitleCue>, String> {
    let at = |f: f32| span.0 + (span.1 - span.0) * f;
    ctx.progress(at(0.0), Some("Extracting audio"));
    let tmp = std::env::temp_dir().join(format!("creatora_wh_{}.wav", uuid::Uuid::new_v4()));
    prepare_audio(media_path, &tmp).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    if ctx.is_cancelled() {
        let _ = std::fs::remove_file(&tmp);
        return Err("cancelled".into());
    }
    ctx.progress(at(0.1), Some("Transcribing"));
    let out_json = tmp.with_extension("json");
    let mut cmd = crate::proc_ext::silent(whisper);
    cmd.args([
        "-m",
        &model_path.to_string_lossy(),
        "-f",
        &tmp.to_string_lossy(),
        "-ojf",
        "-of",
        &out_json.with_extension("").to_string_lossy(),
    ]);
    if let Some(lang) = language {
        if lang != "auto" {
            cmd.args(["-l", lang]);
        }
    }
    // `-pp` makes whisper report "progress = NN%" on stderr; stdout (the
    // live transcript) is discarded so a full pipe can never stall it.
    cmd.arg("-pp").stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pct = Arc::new(AtomicU32::new(0));
    let reader = child.stderr.take().map(|se| {
        let pct = pct.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(se).lines().map_while(Result::ok) {
                if let Some(n) = parse_progress(&line) {
                    pct.store(n, Ordering::Relaxed);
                }
            }
        })
    });
    let status = loop {
        if ctx.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&tmp);
            let _ = std::fs::remove_file(&out_json);
            return Err("cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                let p = pct.load(Ordering::Relaxed).min(100) as f32 / 100.0;
                ctx.progress(at(0.1 + 0.85 * p), Some("Transcribing"));
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        }
    };
    if let Some(h) = reader {
        let _ = h.join();
    }
    let _ = std::fs::remove_file(&tmp);
    if !status.success() {
        return Err("whisper transcription failed".into());
    }
    ctx.progress(at(0.95), Some("Reading transcript"));
    let json = std::fs::read_to_string(&out_json).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out_json);
    Ok(parse_whisper_json(&json))
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
    let model_path = find_model(&app, &model)?
        .ok_or_else(|| AppError::NotFound(format!("model not downloaded: {model}")))?;
    let whisper =
        whisper_path().ok_or_else(|| AppError::NotFound("whisper-cli not provisioned".into()))?;
    let job_id = jobs.spawn(app, "subtitles.transcribe", move |ctx: &JobCtx| {
        let cues = transcribe_to_cues(
            ctx,
            &whisper,
            &model_path,
            Path::new(&media_path),
            language.as_deref(),
            (0.05, 0.95),
        )?;
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

#[cfg(test)]
mod progress_tests {
    use super::parse_progress;

    #[test]
    fn whisper_progress_lines_parse() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress =  42%"),
            Some(42)
        );
        assert_eq!(parse_progress("progress = 100%"), Some(100));
        assert_eq!(
            parse_progress("whisper_init_state: kv self size = 3MB"),
            None
        );
        assert_eq!(parse_progress(""), None);
    }
}
