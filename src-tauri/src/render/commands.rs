//! `export_project` — compile the saved timeline to an ffmpeg plan and run it
//! inside the job engine. Progress is real (ffmpeg `-progress pipe:1`),
//! cancellation kills the child process and removes the partial output.

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::{JobCtx, JobManager};
use crate::media::{self, probe};
use crate::project::store;
use crate::render::plan::{self, RenderPlan, SourceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub duration_ms: i64,
    pub bytes: u64,
    pub skipped_clips: usize,
}

/// Resolve each `media_refs` entry to a `SourceInfo`: catalog row first
/// (kind + audio_codec), falling back to the stored path + a live probe.
pub fn resolve_sources(
    doc: &crate::project::document::ProjectDoc,
    db: Option<&Db>,
) -> HashMap<String, SourceInfo> {
    let mut map: HashMap<String, SourceInfo> = HashMap::new();
    for m in &doc.media_refs {
        if map.contains_key(&m.asset_id) {
            continue;
        }
        let from_db = db.and_then(|d| {
            d.with(|c| {
                Ok(c.query_row(
                    "SELECT kind, file_path, audio_codec FROM media_assets WHERE id = ?1",
                    [&m.asset_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .ok())
            })
            .ok()
            .flatten()
        });
        let info = match from_db {
            Some((kind, file_path, audio_codec)) if Path::new(&file_path).is_file() => SourceInfo {
                path: PathBuf::from(file_path),
                has_audio: audio_codec.is_some() || kind == "audio",
                kind,
            },
            _ => {
                let p = PathBuf::from(&m.path);
                if !p.is_file() {
                    continue;
                }
                match probe::probe(&p) {
                    Ok(i) => SourceInfo {
                        path: p,
                        kind: probe::classify(&i, &PathBuf::from(&m.path)).to_string(),
                        has_audio: i.has_audio,
                    },
                    Err(_) => continue,
                }
            }
        };
        // Key by asset id and by path — collect_segments may look up either.
        map.insert(m.asset_id.clone(), info.clone());
        map.insert(m.path.clone(), info);
    }
    map
}

/// Spawn ffmpeg for `plan`, stream `-progress` to `progress`, honor
/// cancellation (`cancelled() → kill child + remove partial output`).
/// Decoupled from JobCtx so integration tests run it directly.
pub fn run_ffmpeg(
    plan: &RenderPlan,
    out: &Path,
    mut progress: impl FnMut(f32),
    cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    let ffmpeg = media::ffmpeg_path()
        .ok_or_else(|| "ffmpeg not found — install FFmpeg or set CREATORA_FFMPEG".to_string())?;
    let mut args = vec![
        "-nostdin".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
    ];
    args.extend(plan.ffmpeg_args(out));

    log::info!("render: ffmpeg {}", args.join(" "));
    let mut child: Child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;

    let stdout = child.stdout.take().expect("piped stdout");
    let reader = BufReader::new(stdout);
    let total_us = (plan.duration_ms.max(1) as f64) * 1000.0;
    let mut last_err = String::new();

    for line in reader.lines() {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(out);
            return Err("cancelled".into());
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        // ffmpeg's `-progress` reports out_time_ms in microseconds (historical).
        for key in ["out_time_ms=", "out_time_us="] {
            if let Some(v) = line.strip_prefix(key) {
                if let Ok(us) = v.trim().parse::<i64>() {
                    progress((us as f64 / total_us) as f32);
                }
            }
        }
    }

    let status = child.wait().map_err(|e| format!("wait ffmpeg: {e}"))?;
    if let Some(mut err) = child.stderr.take() {
        use std::io::Read;
        let mut buf = String::new();
        let _ = err.read_to_string(&mut buf);
        last_err = buf;
    }
    if !status.success() {
        let _ = std::fs::remove_file(out);
        let tail = last_err
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!("ffmpeg exited {status}: {tail}"));
    }
    progress(1.0);
    Ok(())
}

/// Export the saved project at `project_path` to `out_path`.
/// Runs as a job — returns the job id; result arrives via `job://finished`.
#[tauri::command]
pub fn export_project(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    project_path: String,
    out_path: String,
    version_id: Option<String>,
) -> CmdResult<String> {
    let project_path = PathBuf::from(&project_path);
    let out_path = PathBuf::from(&out_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let db2 = (*db).clone();
    let payload = serde_json::json!({
        "projectPath": project_path,
        "outputPath": out_path,
        "versionId": version_id,
        "projectName": project_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string()),
        "outputFile": out_path.file_name().map(|s| s.to_string_lossy().to_string()),
    });
    let job_id = jobs.spawn_with_payload(
        app.clone(),
        "render.export",
        &payload,
        move |ctx: &JobCtx| {
            run_export_body(ctx, &project_path, &out_path, version_id.as_deref(), &db2)
        },
    );
    Ok(job_id)
}

/// The export body, extracted so other commands (social export) can run a
/// render inside their own job without duplicating the render pipeline.
pub fn run_export_body(
    ctx: &JobCtx,
    project_path: &std::path::Path,
    out_path: &std::path::Path,
    version_id: Option<&str>,
    db2: &Arc<Db>,
) -> Result<serde_json::Value, String> {
    {
        let doc = store::open(project_path).map_err(|e| e.to_string())?;
        let export = version_id
            .and_then(|id| doc.version(id))
            .map(|v| v.export.clone())
            .unwrap_or_default();
        let doc = match version_id {
            Some(id) => doc
                .apply_version(id)
                .ok_or_else(|| format!("unknown version: {id}"))?,
            None => doc,
        };
        // Container-correct extension — settings never silently ignored.
        let mut out_path = out_path.to_path_buf();
        let want_ext = export.container.clone();
        if out_path
            .extension()
            .map_or(true, |x| x != want_ext.as_str())
        {
            out_path.set_extension(&want_ext);
        }
        let sources = resolve_sources(&doc, Some(db2));
        let mut plan = plan::build_plan_with(&doc, &sources, &export).map_err(|e| e.to_string())?;
        // Subtitle burn-in via libass — cues are timeline-absolute ms which
        // maps 1:1 to output time (ADR-025). Temp file lives for the job.
        let _ass_tmp = if !doc.subtitles.is_empty() {
            let ass = crate::subtitles::to_ass(&doc, &doc.subtitles, &doc.subtitle_style);
            let tmp =
                std::env::temp_dir().join(format!("creatora_subs_{}.ass", std::process::id()));
            std::fs::write(&tmp, ass).map_err(|e| e.to_string())?;
            plan.with_ass(tmp.clone());
            Some(tmp)
        } else {
            None
        };
        let clip_count = doc
            .timeline
            .tracks
            .iter()
            .map(|t| t.clips.len())
            .sum::<usize>();
        run_ffmpeg(
            &plan,
            &out_path,
            |f| ctx.progress(f, Some("Rendering")),
            || ctx.is_cancelled(),
        )?;
        if let Some(t) = &_ass_tmp {
            let _ = std::fs::remove_file(t);
        }
        let bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        serde_json::to_value(ExportResult {
            output_path: out_path.to_string_lossy().into_owned(),
            duration_ms: plan.duration_ms,
            bytes,
            skipped_clips: clip_count.saturating_sub(plan.segments.len()),
        })
        .map_err(|e| e.to_string())
    }
}

/// Batch export: one job per version (independent progress/cancel/error).
/// `version_ids` empty → base doc only. Returns job ids in order.
#[tauri::command]
pub fn export_versions(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    project_path: String,
    out_dir: String,
    version_ids: Vec<String>,
) -> CmdResult<Vec<String>> {
    let mut ids = Vec::new();
    let targets: Vec<(Option<String>, String)> = if version_ids.is_empty() {
        vec![(None, "master".into())]
    } else {
        version_ids
            .into_iter()
            .map(|v| (Some(v.clone()), v))
            .collect()
    };
    for (vid, name) in targets {
        let out = PathBuf::from(&out_dir).join(format!("{name}.mp4"));
        ids.push(export_project(
            app.clone(),
            jobs.clone(),
            db.clone(),
            project_path.clone(),
            out.to_string_lossy().into_owned(),
            vid,
        )?);
    }
    Ok(ids)
}

/// Validate + report render feasibility without running ffmpeg.
/// Lets the UI warn about missing media before starting a job.
#[tauri::command]
pub fn preview_render_plan(
    db: State<'_, Arc<Db>>,
    project_path: String,
) -> CmdResult<serde_json::Value> {
    let doc = store::open(&PathBuf::from(&project_path))?;
    let sources = resolve_sources(&doc, Some(&db));
    match plan::build_plan(&doc, &sources) {
        Ok(p) => Ok(serde_json::json!({
            "ok": true,
            "durationMs": p.duration_ms,
            "segments": p.segments.len(),
            "hasAudio": p.has_audio,
        })),
        Err(AppError::InvalidInput(m)) => Ok(serde_json::json!({ "ok": false, "reason": m })),
        Err(e) => Err(e),
    }
}

/// Analyze a clip's source for subject tracking → motion samples the
/// frontend maps to reframe keyframes (ADR-023). Job-based.
#[tauri::command]
pub fn analyze_subject(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    path: String,
    in_ms: i64,
    out_ms: i64,
    samples: u32,
) -> CmdResult<String> {
    let job_id = jobs.spawn(app, "reframe.analyze", move |ctx: &JobCtx| {
        ctx.progress(0.1, Some("Analyzing motion"));
        let samples =
            crate::render::reframe::analyze_motion(Path::new(&path), in_ms, out_ms, samples)
                .map_err(|e| e.to_string())?;
        ctx.progress(1.0, None);
        serde_json::to_value(samples).map_err(|e| e.to_string())
    });
    Ok(job_id)
}
