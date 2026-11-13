//! Media catalog commands: import (job-driven), list/search, relink,
//! missing-media sweep, delete.

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::{JobCtx, JobManager};
use crate::media::probe;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::{Manager, State};
use xxhash_rust::xxh3::xxh3_64;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub kind: String,
    pub file_path: String,
    pub name: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub codec: Option<String>,
    pub thumbnail_path: Option<String>,
    pub status: String,
    /// Set when a different existing asset has the same content hash.
    pub duplicate_of: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: Vec<AssetSummary>,
    /// Per-file failures (missing file, unreadable, ffprobe error).
    pub errors: Vec<(String, String)>,
    pub cancelled: bool,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_data_dir: {e}")))
}

/// Fast content fingerprint: xxh3 of the first 4 MiB + size suffix.
/// Enough for duplicate detection without reading multi-GB files twice.
fn content_hash(path: &Path) -> Result<String, AppError> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    let size = f.metadata()?.len();
    Ok(format!("{:016x}:{}", xxh3_64(&buf), size))
}

/// Thumbnail via ffmpeg: for video seek ~1s, single scaled frame → JPEG.
/// Returns output path on success; failures are non-fatal (None).
fn make_thumbnail(thumbs_dir: &Path, asset_id: &str, src: &Path, seek_ms: Option<i64>) -> Option<PathBuf> {
    let ffmpeg = super::ffmpeg_path()?;
    std::fs::create_dir_all(thumbs_dir).ok()?;
    let out = thumbs_dir.join(format!("{asset_id}.jpg"));
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error").arg("-y");
    if let Some(ms) = seek_ms {
        cmd.arg("-ss").arg(format!("{:.3}", ms as f64 / 1000.0));
    }
    cmd.arg("-i").arg(src)
        .arg("-frames:v").arg("1")
        .arg("-vf").arg("scale='min(320,iw)':-2")
        .arg(&out);
    match cmd.output() {
        Ok(o) if o.status.success() && out.is_file() => Some(out),
        _ => None,
    }
}

fn is_probably_media(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "m4v" | "mts" | "mpg" | "mpeg"
            | "mp3" | "wav" | "aac" | "m4a" | "flac" | "ogg" | "opus" | "wma"
            | "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tiff" | "tif"
    )
}

fn existing_by_path(db: &Db, path: &Path) -> Result<Option<AssetSummary>, AppError> {
    db.with(|c| {
        let p = path.to_string_lossy().to_string();
        let mut stmt = c.prepare(
            "SELECT id, kind, file_path, name, width, height, duration_ms, codec, thumbnail_path, status
             FROM media_assets WHERE file_path = ?1",
        )?;
        let mut rows = stmt.query_map([p], row_to_asset)?;
        Ok(rows.next().transpose()?)
    })
}

fn hash_collision(db: &Db, hash: &str) -> Result<Option<String>, AppError> {
    db.with(|c| {
        c.query_row(
            "SELECT id FROM media_assets WHERE file_hash = ?1 LIMIT 1",
            [hash],
            |r| r.get(0),
        )
        .ok()
        .pipe(Ok)
    })
}

fn row_to_asset(r: &rusqlite::Row) -> rusqlite::Result<AssetSummary> {
    Ok(AssetSummary {
        id: r.get(0)?,
        kind: r.get(1)?,
        file_path: r.get(2)?,
        name: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        duration_ms: r.get(6)?,
        codec: r.get(7)?,
        thumbnail_path: r.get(8)?,
        status: r.get(9)?,
        duplicate_of: None,
    })
}

/// Import a single file: dedup by path → content hash → ffprobe → thumbnail →
/// catalog row. Returns the asset summary; per-file errors are strings so the
/// job can report them individually without aborting the batch.
pub fn import_one(
    thumbs_dir: &Path,
    db: &Db,
    path: &Path,
) -> Result<AssetSummary, String> {
    if !path.is_file() {
        return Err("file not found".into());
    }
    if let Some(existing) = existing_by_path(db, path).map_err(|e| e.to_string())? {
        return Ok(existing);
    }

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let size = path.metadata().map(|m| m.len() as i64).unwrap_or(0);
    let hash = content_hash(path).unwrap_or_default();
    let duplicate_of = hash_collision(db, &hash).map_err(|e| e.to_string())?;

    // ffprobe media files; binary assets (fonts, .creatora) skip probe.
    let info = if is_probably_media(path) {
        Some(probe::probe(path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let kind = info
        .as_ref()
        .map(|i| probe::classify(i, path))
        .unwrap_or_else(|| probe::classify(
            &probe::MediaInfo {
                width: None, height: None, duration_ms: None,
                fps_num: None, fps_den: None, codec: None, audio_codec: None,
                has_video: false, has_audio: false,
                raw: serde_json::Value::Null,
            },
            path,
        ))
        .to_string();

    let id = uuid::Uuid::new_v4().to_string();

    // Thumbnail for video + image.
    let thumb = match kind.as_str() {
        "video" => make_thumbnail(thumbs_dir, &id, path, Some(1000)),
        "image" => make_thumbnail(thumbs_dir, &id, path, None),
        _ => None,
    };

    let (w, h, dur, codec, meta_json) = info
        .as_ref()
        .map(|i| {
            (
                i.width.map(|v| v as i64),
                i.height.map(|v| v as i64),
                i.duration_ms,
                i.codec.clone(),
                Some(i.raw.to_string()),
            )
        })
        .unwrap_or((None, None, None, None, None));

    db.with(|c| {
        c.execute(
            "INSERT INTO media_assets
             (id, kind, file_path, file_hash, file_size, name, width, height,
              duration_ms, fps_num, fps_den, codec, audio_codec, thumbnail_path, metadata_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                id, kind, path.to_string_lossy().to_string(), hash, size, name,
                w, h, dur,
                info.as_ref().and_then(|i| i.fps_num.map(|v| v as i64)),
                info.as_ref().and_then(|i| i.fps_den.map(|v| v as i64)),
                codec,
                info.as_ref().and_then(|i| i.audio_codec.clone()),
                thumb.as_ref().map(|p| p.to_string_lossy().to_string()),
                meta_json,
            ],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    Ok(AssetSummary {
        id,
        kind,
        file_path: path.to_string_lossy().to_string(),
        name,
        width: w,
        height: h,
        duration_ms: dur,
        codec,
        thumbnail_path: thumb.map(|p| p.to_string_lossy().to_string()),
        status: "ok".into(),
        duplicate_of,
    })
}

/// Start an import job — returns job id; progress via `job://*`, result in
/// `job://finished` payload (ImportOutcome serialized).
#[tauri::command]
pub fn import_media(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    paths: Vec<String>,
) -> CmdResult<String> {
    let db = (*db).clone();
    let thumbs_dir = data_dir(&app)?.join("thumbs");
    let job_id = jobs.spawn(app.clone(), "media.import", move |ctx: &JobCtx| {
        let total = paths.len().max(1) as f32;
        let mut imported = Vec::new();
        let mut errors = Vec::new();
        let mut cancelled = false;
        for (i, p) in paths.iter().enumerate() {
            if ctx.is_cancelled() {
                cancelled = true;
                break;
            }
            let path = PathBuf::from(p);
            ctx.progress(
                i as f32 / total,
                path.file_name().and_then(|n| n.to_str()),
            );
            match import_one(&thumbs_dir, &db, &path) {
                Ok(a) => imported.push(a),
                Err(e) => errors.push((p.clone(), e)),
            }
        }
        ctx.progress(1.0, None);
        serde_json::to_value(ImportOutcome {
            imported,
            errors,
            cancelled,
        })
        .map_err(|e| e.to_string())
    });
    Ok(job_id)
}

#[tauri::command]
pub fn cancel_job(jobs: State<'_, JobManager>, job_id: String) -> CmdResult<bool> {
    Ok(jobs.cancel(&job_id))
}

#[tauri::command]
pub fn list_assets(
    db: State<'_, Arc<Db>>,
    kind: Option<String>,
    query: Option<String>,
) -> CmdResult<Vec<AssetSummary>> {
    db.with(|c| {
        let mut sql = String::from(
            "SELECT id, kind, file_path, name, width, height, duration_ms, codec, thumbnail_path, status
             FROM media_assets WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(k) = &kind {
            params.push(Box::new(k.clone()));
            sql.push_str(&format!(" AND kind = ?{}", params.len()));
        }
        if let Some(q) = &query {
            if !q.is_empty() {
                params.push(Box::new(format!("%{q}%")));
                sql.push_str(&format!(" AND name LIKE ?{}", params.len()));
            }
        }
        sql.push_str(" ORDER BY imported_at DESC");
        let mut stmt = c.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(refs.as_slice(), row_to_asset)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Mark assets whose file disappeared; clear flag for files that came back.
#[tauri::command]
pub fn scan_missing_assets(db: State<'_, Arc<Db>>) -> CmdResult<u64> {
    db.with(|c| {
        let mut stmt = c.prepare("SELECT id, file_path, status FROM media_assets")?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mut changed = 0u64;
        for (id, path, status) in rows {
            let missing = !PathBuf::from(&path).is_file();
            let want = if missing { "missing" } else { "ok" };
            if want != status {
                c.execute(
                    "UPDATE media_assets SET status = ?1 WHERE id = ?2",
                    [want, &id],
                )?;
                changed += 1;
            }
        }
        Ok(changed)
    })
}

#[tauri::command]
pub fn relink_asset(db: State<'_, Arc<Db>>, id: String, new_path: String) -> CmdResult<()> {
    let p = PathBuf::from(&new_path);
    if !p.is_file() {
        return Err(AppError::NotFound(format!("file not found: {new_path}")));
    }
    db.with(|c| {
        c.execute(
            "UPDATE media_assets SET file_path = ?1, status = 'ok', last_seen_at = datetime('now')
             WHERE id = ?2",
            [p.to_string_lossy().to_string(), id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn delete_asset(db: State<'_, Arc<Db>>, id: String) -> CmdResult<()> {
    db.with(|c| {
        c.execute("DELETE FROM media_assets WHERE id = ?1", [&id])?;
        Ok(())
    })
}

// tiny pipe helper (avoid pullin-in a crate for one use)
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}
