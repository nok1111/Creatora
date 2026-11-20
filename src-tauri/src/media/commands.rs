//! Media catalog commands: import (job-driven), list/search, relink,
//! missing-media sweep, delete.

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::jobs::{JobCtx, JobManager};
use crate::media::probe;
use rusqlite::OptionalExtension;
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
    /// Audio stream codec, when the container carries one.
    pub audio_codec: Option<String>,
    pub thumbnail_path: Option<String>,
    pub status: String,
    /// Low-res mezzanine for preview (`proxies/<id>.mp4`), if generated.
    pub proxy_path: Option<String>,
    /// Set when a different existing asset has the same content hash.
    pub duplicate_of: Option<String>,
    pub is_favorite: bool,
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
pub fn make_thumbnail(
    thumbs_dir: &Path,
    asset_id: &str,
    src: &Path,
    seek_ms: Option<i64>,
) -> Option<PathBuf> {
    let ffmpeg = super::ffmpeg_path()?;
    std::fs::create_dir_all(thumbs_dir).ok()?;
    let out = thumbs_dir.join(format!("{asset_id}.jpg"));
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y");
    if let Some(ms) = seek_ms {
        cmd.arg("-ss").arg(format!("{:.3}", ms as f64 / 1000.0));
    }
    cmd.arg("-i")
        .arg(src)
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale='min(320,iw)':-2")
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
        "mp4"
            | "mov"
            | "mkv"
            | "avi"
            | "webm"
            | "m4v"
            | "mts"
            | "mpg"
            | "mpeg"
            | "mp3"
            | "wav"
            | "aac"
            | "m4a"
            | "flac"
            | "ogg"
            | "opus"
            | "wma"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "bmp"
            | "tiff"
            | "tif"
    )
}

fn existing_by_path(db: &Db, path: &Path) -> Result<Option<AssetSummary>, AppError> {
    db.with(|c| {
        let p = path.to_string_lossy().to_string();
        let mut stmt = c.prepare(
            "SELECT id, kind, file_path, name, width, height, duration_ms, codec, thumbnail_path, status, is_favorite, proxy_path, audio_codec
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
        is_favorite: r.get::<_, i64>(10)? != 0,
        proxy_path: r.get(11)?,
        audio_codec: r.get(12)?,
    })
}

/// Import a single file: dedup by path → content hash → ffprobe → thumbnail →
/// catalog row. Returns the asset summary; per-file errors are strings so the
/// job can report them individually without aborting the batch.
pub fn import_one(thumbs_dir: &Path, db: &Db, path: &Path) -> Result<AssetSummary, String> {
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
        .unwrap_or_else(|| {
            probe::classify(
                &probe::MediaInfo {
                    width: None,
                    height: None,
                    duration_ms: None,
                    fps_num: None,
                    fps_den: None,
                    codec: None,
                    audio_codec: None,
                    has_video: false,
                    has_audio: false,
                    raw: serde_json::Value::Null,
                },
                path,
            )
        })
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

    let audio_codec = info.as_ref().and_then(|i| i.audio_codec.clone());
    db.with(|c| {
        c.execute(
            "INSERT INTO media_assets
             (id, kind, file_path, file_hash, file_size, name, width, height,
              duration_ms, fps_num, fps_den, codec, audio_codec, thumbnail_path, metadata_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            rusqlite::params![
                id,
                kind,
                path.to_string_lossy().to_string(),
                hash,
                size,
                name,
                w,
                h,
                dur,
                info.as_ref().and_then(|i| i.fps_num.map(|v| v as i64)),
                info.as_ref().and_then(|i| i.fps_den.map(|v| v as i64)),
                codec,
                audio_codec,
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
        is_favorite: false,
        proxy_path: None,
        audio_codec,
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
            ctx.progress(i as f32 / total, path.file_name().and_then(|n| n.to_str()));
            match import_one(&thumbs_dir, &db, &path) {
                Ok(a) => {
                    // Authorize the imported file's directory for asset://.
                    if let Some(dir) = path.parent() {
                        let _ = app.asset_protocol_scope().allow_directory(dir, true);
                    }
                    imported.push(a)
                }
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

/// Bundled SFX library dir: `sfx/` beside the exe (install resources), or
/// `shared/sfx/files` in the repo for dev builds.
fn sfx_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(dir.join("sfx"));
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shared/sfx/files"));
    }
    candidates.into_iter().find(|d| d.is_dir())
}

/// Bulk-import bundled SFX as regular `audio` assets, lazily — only sounds
/// the user actually drops enter the catalog (import_one dedups by path),
/// so the media bin stays clean while preview/export resolve normally.
#[tauri::command]
pub fn import_sfx(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    files: Vec<String>,
) -> CmdResult<Vec<AssetSummary>> {
    let dir = sfx_dir().ok_or_else(|| AppError::NotFound("sfx dir".into()))?;
    let thumbs_dir = data_dir(&app)?.join("thumbs");
    let mut out = Vec::with_capacity(files.len());
    for f in &files {
        if f.contains("..") || f.contains('/') || f.contains('\\') {
            continue;
        }
        let path = dir.join(f);
        if !path.is_file() {
            continue;
        }
        if let Ok(a) = import_one(&thumbs_dir, &db, &path) {
            out.push(a);
        }
    }
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    Ok(out)
}

/// Durable job rows for the Export Center / activity views.
/// `kind_prefix` e.g. "render.export", "social.", None = everything.
#[tauri::command]
pub fn list_jobs(
    jobs: State<'_, JobManager>,
    kind_prefix: Option<String>,
    limit: Option<i64>,
) -> CmdResult<Vec<serde_json::Value>> {
    Ok(jobs.list(kind_prefix.as_deref(), limit.unwrap_or(100).clamp(1, 500)))
}

/// Regenerate a missing/failed thumbnail for a single asset. Returns the
/// new path (or None when the kind can't produce one / ffmpeg fails).
#[tauri::command]
pub fn regenerate_thumbnail(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    asset_id: String,
) -> CmdResult<Option<String>> {
    let thumbs_dir = data_dir(&app)?.join("thumbs");
    db.with(|c| {
        let (kind, fp): (String, String) = c
            .query_row(
                "SELECT kind, file_path FROM media_assets WHERE id=?1",
                [&asset_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::NotFound(format!("asset {asset_id}")))?;
        let src = PathBuf::from(&fp);
        if !src.is_file() {
            return Err(AppError::NotFound(format!("source file {fp}")));
        }
        let seek = if kind == "video" { Some(1000) } else { None };
        let out = make_thumbnail(&thumbs_dir, &asset_id, &src, seek)
            .map(|p| p.to_string_lossy().to_string());
        c.execute(
            "UPDATE media_assets SET thumbnail_path=?1 WHERE id=?2",
            rusqlite::params![out, asset_id],
        )?;
        Ok(out)
    })
}

#[tauri::command]
pub fn list_assets(
    db: State<'_, Arc<Db>>,
    kind: Option<String>,
    query: Option<String>,
    favorites_only: Option<bool>,
    collection_id: Option<String>,
    tag_id: Option<String>,
) -> CmdResult<Vec<AssetSummary>> {
    db.with(|c| {
        let mut sql = String::from(
            "SELECT DISTINCT a.id, a.kind, a.file_path, a.name, a.width, a.height,
                    a.duration_ms, a.codec, a.thumbnail_path, a.status, a.is_favorite, a.proxy_path, a.audio_codec
             FROM media_assets a WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut next = |v: Box<dyn rusqlite::ToSql>| {
            params.push(v);
            format!("?{}", params.len())
        };
        if let Some(k) = &kind {
            if k != "all" {
                sql.push_str(&format!(" AND a.kind = {}", next(Box::new(k.clone()))));
            }
        }
        if let Some(q) = &query {
            if !q.is_empty() {
                sql.push_str(&format!(
                    " AND a.name LIKE {}",
                    next(Box::new(format!("%{q}%")))
                ));
            }
        }
        if favorites_only == Some(true) {
            sql.push_str(" AND a.is_favorite = 1");
        }
        if let Some(cid) = &collection_id {
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM asset_collection ac
                 WHERE ac.asset_id = a.id AND ac.collection_id = {})",
                next(Box::new(cid.clone()))
            ));
        }
        if let Some(tid) = &tag_id {
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM asset_tag at
                 WHERE at.asset_id = a.id AND at.tag_id = {})",
                next(Box::new(tid.clone()))
            ));
        }
        sql.push_str(" ORDER BY a.imported_at DESC");
        let mut stmt = c.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |r| {
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
                    is_favorite: r.get::<_, i64>(10)? != 0,
                    proxy_path: r.get(11)?,
                    audio_codec: r.get(12)?,
                })
            })?
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
pub fn relink_asset(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
    new_path: String,
) -> CmdResult<()> {
    let p = PathBuf::from(&new_path);
    if !p.is_file() {
        return Err(AppError::NotFound(format!("file not found: {new_path}")));
    }
    if let Some(dir) = p.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
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
pub fn delete_asset(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
) -> CmdResult<()> {
    // Collect generated files first; delete only what no other asset still
    // references and only under the app data dir — never user media.
    let data = data_dir(&app)?;
    let (thumb, proxy): (Option<String>, Option<String>) = db.with(|c| {
        c.query_row(
            "SELECT thumbnail_path, proxy_path FROM media_assets WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::NotFound(format!("asset {id}")))
    })?;
    db.with(|c| {
        c.execute("DELETE FROM media_assets WHERE id = ?1", [&id])?;
        Ok(())
    })?;
    for f in [thumb, proxy].into_iter().flatten() {
        let path = PathBuf::from(&f);
        if !path.starts_with(&data) {
            continue;
        }
        let still_used: bool = db.with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM media_assets
                 WHERE thumbnail_path=?1 OR proxy_path=?1",
                [&f],
                |r| r.get::<_, i64>(0),
            )? > 0)
        })?;
        if !still_used {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Remove generated thumbnails/proxies whose owning asset row no longer
/// exists. Runs at startup and after deletes; only touches files inside the
/// app data dir that are not referenced by any remaining asset row.
pub fn sweep_orphan_media(data: &Path, db: &Db) -> u64 {
    let mut removed = 0u64;
    for dir_name in ["thumbs", "proxies"] {
        let dir = data.join(dir_name);
        if !dir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let f = path.to_string_lossy().to_string();
            let used: i64 = db
                .with(|c| {
                    Ok(c.query_row(
                        "SELECT COUNT(*) FROM media_assets
                         WHERE thumbnail_path=?1 OR proxy_path=?1",
                        [&f],
                        |r| r.get(0),
                    )?)
                })
                .unwrap_or(1); // on error keep the file
            if used == 0 && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[tauri::command]
pub fn sweep_orphan_files(app: tauri::AppHandle, db: State<'_, Arc<Db>>) -> CmdResult<u64> {
    let data = data_dir(&app)?;
    Ok(sweep_orphan_media(&data, &db))
}

#[tauri::command]
pub fn set_asset_favorite(db: State<'_, Arc<Db>>, id: String, favorite: bool) -> CmdResult<()> {
    db.with(|c| {
        c.execute(
            "UPDATE media_assets SET is_favorite = ?1 WHERE id = ?2",
            rusqlite::params![favorite as i64, id],
        )?;
        Ok(())
    })
}

// ---- Collections ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub asset_count: i64,
}

#[tauri::command]
pub fn list_collections(db: State<'_, Arc<Db>>) -> CmdResult<Vec<CollectionSummary>> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT c.id, c.name, c.parent_id,
                    (SELECT COUNT(*) FROM asset_collection ac WHERE ac.collection_id = c.id)
             FROM collections c ORDER BY c.name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CollectionSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    asset_count: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn create_collection(
    db: State<'_, Arc<Db>>,
    name: String,
    parent_id: Option<String>,
) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err(AppError::InvalidInput("collection name required".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.with(|c| {
        c.execute(
            "INSERT INTO collections (id, name, parent_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, name, parent_id],
        )?;
        Ok(())
    })?;
    Ok(id)
}

#[tauri::command]
pub fn delete_collection(db: State<'_, Arc<Db>>, id: String) -> CmdResult<()> {
    db.with(|c| {
        c.execute(
            "DELETE FROM asset_collection WHERE collection_id = ?1",
            [&id],
        )?;
        c.execute("DELETE FROM collections WHERE id = ?1", [&id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn assign_asset_to_collection(
    db: State<'_, Arc<Db>>,
    asset_id: String,
    collection_id: String,
) -> CmdResult<()> {
    db.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO asset_collection (asset_id, collection_id) VALUES (?1, ?2)",
            [asset_id, collection_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn remove_asset_from_collection(
    db: State<'_, Arc<Db>>,
    asset_id: String,
    collection_id: String,
) -> CmdResult<()> {
    db.with(|c| {
        c.execute(
            "DELETE FROM asset_collection WHERE asset_id = ?1 AND collection_id = ?2",
            [asset_id, collection_id],
        )?;
        Ok(())
    })
}

// ---- Tags ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub id: String,
    pub name: String,
    pub asset_count: i64,
}

#[tauri::command]
pub fn list_tags(db: State<'_, Arc<Db>>) -> CmdResult<Vec<TagSummary>> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT t.id, t.name,
                    (SELECT COUNT(*) FROM asset_tag at2 WHERE at2.tag_id = t.id)
             FROM tags t ORDER BY t.name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TagSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    asset_count: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Tag by name — creates the tag if new (case-insensitive dedup).
#[tauri::command]
pub fn tag_asset(db: State<'_, Arc<Db>>, asset_id: String, tag: String) -> CmdResult<()> {
    let tag = tag.trim();
    if tag.is_empty() || tag.len() > 64 {
        return Err(AppError::InvalidInput("tag must be 1-64 chars".into()));
    }
    db.with(|c| {
        let tag_id: String = match c.query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
            [tag],
            |r| r.get(0),
        ) {
            Ok(id) => id,
            Err(_) => {
                let id = uuid::Uuid::new_v4().to_string();
                c.execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", [&id, tag])?;
                id
            }
        };
        c.execute(
            "INSERT OR IGNORE INTO asset_tag (asset_id, tag_id) VALUES (?1, ?2)",
            [asset_id, tag_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn untag_asset(db: State<'_, Arc<Db>>, asset_id: String, tag_id: String) -> CmdResult<()> {
    db.with(|c| {
        c.execute(
            "DELETE FROM asset_tag WHERE asset_id = ?1 AND tag_id = ?2",
            [asset_id, tag_id],
        )?;
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

// ---------- proxies (preview performance) ----------

/// Transcode one asset to a lightweight preview proxy:
/// H.264 ≤960×540 CRF30 + AAC96k — fast decode, same duration/timing so the
/// preview's source-time math is unchanged (proxies are only ever a
/// *display* source; render always reads originals).
pub fn proxy_one(proxies_dir: &Path, db: &Db, asset_id: &str) -> Result<String, String> {
    let (kind, src) = db
        .with(|c| {
            Ok(c.query_row(
                "SELECT kind, file_path FROM media_assets WHERE id = ?1",
                [asset_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?)
        })
        .map_err(|e| e.to_string())?;
    if kind != "video" {
        return Err("proxies only apply to video assets".into());
    }
    if !PathBuf::from(&src).is_file() {
        return Err("source file missing".into());
    }
    std::fs::create_dir_all(proxies_dir).map_err(|e| e.to_string())?;
    let out = proxies_dir.join(format!("{asset_id}.mp4"));
    let status = std::process::Command::new(crate::media::ffmpeg_path().ok_or("ffmpeg not found")?)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &src,
            "-vf",
            "scale='min(960,iw)':-2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
        ])
        .arg(&out)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&out);
        return Err("proxy transcode failed".into());
    }
    let p = out.to_string_lossy().into_owned();
    db.with(|c| {
        Ok(c.execute(
            "UPDATE media_assets SET proxy_path = ?1 WHERE id = ?2",
            rusqlite::params![p, asset_id],
        )?)
    })
    .map_err(|e| e.to_string())?;
    Ok(p)
}

#[tauri::command]
pub fn generate_proxies(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    db: State<'_, Arc<Db>>,
    asset_ids: Vec<String>,
) -> CmdResult<String> {
    let db = (*db).clone();
    let proxies_dir = data_dir(&app)?.join("proxies");
    let job_id = jobs.spawn(app, "media.proxies", move |ctx: &JobCtx| {
        let total = asset_ids.len().max(1) as f32;
        let mut done: Vec<String> = Vec::new();
        let mut errors: Vec<(String, String)> = Vec::new();
        for (i, id) in asset_ids.iter().enumerate() {
            if ctx.is_cancelled() {
                break;
            }
            ctx.progress(i as f32 / total, Some(id));
            match proxy_one(&proxies_dir, &db, id) {
                Ok(_) => done.push(id.clone()),
                Err(e) => errors.push((id.clone(), e)),
            }
        }
        ctx.progress(1.0, None);
        serde_json::to_value(serde_json::json!({
            "done": done,
            "errors": errors,
        }))
        .map_err(|e| e.to_string())
    });
    Ok(job_id)
}

/// Remove a proxy file and clear `proxy_path` — preview falls back to the
/// original source.
#[tauri::command]
pub fn delete_proxy(db: State<'_, Arc<Db>>, asset_id: String) -> CmdResult<()> {
    let row: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT proxy_path FROM media_assets WHERE id = ?1",
            [&asset_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
    })?;
    if let Some(p) = row {
        let _ = std::fs::remove_file(&p);
    }
    db.with(|c| {
        Ok(c.execute(
            "UPDATE media_assets SET proxy_path = NULL WHERE id = ?1",
            [&asset_id],
        )?)
    })?;
    Ok(())
}

// ---------- timeline filmstrips ----------

fn filmstrips_dir(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("filmstrips")
}

fn filmstrip_key(path: &str, frames: usize) -> String {
    let m = std::fs::metadata(path)
        .map(|m| (m.len(), m.modified().ok()))
        .unwrap_or((0, None));
    format!("{:x}", xxh3_64(format!("{path}:{m:?}:{frames}").as_bytes()))
}

/// Kicks off a filmstrip job (or returns null on cache hit). The strip is
/// `frames` tiled JPEG cells covering the whole source duration.
#[tauri::command]
pub fn generate_filmstrip(
    app: tauri::AppHandle,
    jobs: State<'_, JobManager>,
    path: String,
    frames: usize,
) -> CmdResult<Option<String>> {
    // Unresolved mediaRefs arrive as "" — ffmpeg would fail with
    // "Invalid argument" and pollute the job log; return cache-miss.
    if path.is_empty() {
        return Ok(None);
    }
    let out = filmstrips_dir(&app).join(format!("{}.jpg", filmstrip_key(&path, frames)));
    if out.is_file() {
        return Ok(None); // cache hit — read_filmstrip returns the path
    }
    let dir = filmstrips_dir(&app);
    let job_id = jobs.spawn(app, "media.filmstrip", move |ctx: &JobCtx| {
        ctx.progress(0.1, Some("Sampling frames"));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        super::filmstrip::filmstrip(Path::new(&path), &out, frames)?;
        ctx.progress(1.0, None);
        serde_json::to_value(out.to_string_lossy()).map_err(|e| e.to_string())
    });
    Ok(Some(job_id))
}

/// Read a cached filmstrip JPEG path (after job completion or cache hit).
#[tauri::command]
pub fn read_filmstrip(
    app: tauri::AppHandle,
    path: String,
    frames: usize,
) -> CmdResult<Option<String>> {
    let out = filmstrips_dir(&app).join(format!("{}.jpg", filmstrip_key(&path, frames)));
    Ok(out.is_file().then(|| out.to_string_lossy().into_owned()))
}
