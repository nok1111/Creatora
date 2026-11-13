//! Publish packets (Phase 9): self-contained folders for manual
//! publishing on platforms without API access — video + thumbnail +
//! metadata.txt + publication.json. Provenance stays in the packet:
//! platform, target, post, project, remote ids, export settings.
//!
//! Files are hardlinked when on the same volume (no duplication), with
//! a byte-copy fallback. Regeneration writes atomically.

use crate::db::Db;
use crate::error::{AppError, CmdResult};
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketRow {
    pub id: String,
    pub target_id: String,
    pub dir_path: String,
    pub files: Vec<String>,
    pub created_at: String,
}

struct TargetInfo {
    post_id: String,
    platform: String,
    title: String,
    caption: String,
    hashtags: Vec<String>,
    version_id: Option<String>,
    export_path: Option<String>,
    thumbnail_path: Option<String>,
    scheduled_at: Option<String>,
    platform_post_id: Option<String>,
    meta: serde_json::Value,
    project_id: Option<String>,
}

fn load_target(db: &Arc<Db>, target_id: &str) -> Result<TargetInfo, AppError> {
    db.with(|conn| {
        let (post_id, platform, version_id, export_asset_id, meta_json, scheduled_at, ppid) = conn
            .query_row(
                "SELECT post_id, platform, version_id, export_asset_id,
                        platform_meta_json, scheduled_at, platform_post_id
                 FROM social_post_targets WHERE id=?1",
                [target_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .map_err(|_| AppError::NotFound(format!("target {target_id}")))?;
        let (title, caption, hashtags_json, thumb_asset, project_id) = conn.query_row(
            "SELECT title, caption, hashtags_json, thumbnail_asset_id, project_id
             FROM social_posts WHERE id=?1",
            [&post_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )?;
        let export_path = export_asset_id.and_then(|aid| {
            conn.query_row(
                "SELECT file_path FROM media_assets WHERE id=?1",
                [&aid],
                |r| r.get::<_, String>(0),
            )
            .ok()
        });
        let thumbnail_path = thumb_asset.and_then(|aid| {
            conn.query_row(
                "SELECT file_path FROM media_assets WHERE id=?1",
                [&aid],
                |r| r.get::<_, String>(0),
            )
            .ok()
        });
        // Per-target overrides win over the shared post text.
        let (otitle, ocaption, otags) = conn.query_row(
            "SELECT title, caption, hashtags_json FROM social_post_targets WHERE id=?1",
            [target_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        Ok(TargetInfo {
            post_id,
            platform,
            title: otitle.unwrap_or(title),
            caption: ocaption.unwrap_or(caption),
            hashtags: otags
                .and_then(|j| serde_json::from_str(&j).ok())
                .or_else(|| serde_json::from_str(&hashtags_json).ok())
                .unwrap_or_default(),
            version_id,
            export_path,
            thumbnail_path,
            scheduled_at,
            platform_post_id: ppid,
            meta: serde_json::from_str(&meta_json).unwrap_or_default(),
            project_id,
        })
    })
}

fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(40));
    for c in s.chars().take(40) {
        if c.is_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Hardlink when possible (no duplicate bytes), copy otherwise.
fn link_or_copy(src: &Path, dst: &Path) -> Result<(), AppError> {
    if dst.exists() {
        std::fs::remove_file(dst).map_err(|e| AppError::Internal(e.to_string()))?;
    }
    match std::fs::hard_link(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => std::fs::copy(src, dst)
            .map(|_| ())
            .map_err(|e| AppError::Internal(format!("copy {}: {e}", src.display()))),
    }
}

fn write_atomic(path: &Path, content: &str) -> Result<(), AppError> {
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, content).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::Internal(e.to_string()))
}

/// Build one packet for a target. Returns the registry row.
pub fn build_packet(
    db: &Arc<Db>,
    target_id: &str,
    dest_root: &Path,
) -> Result<PacketRow, AppError> {
    let t = load_target(db, target_id)?;
    let export = t
        .export_path
        .as_deref()
        .ok_or_else(|| AppError::InvalidInput("target has no export — export first".into()))?;
    let export = PathBuf::from(export);
    if !export.exists() {
        return Err(AppError::InvalidInput(format!(
            "export file missing: {}",
            export.display()
        )));
    }
    let dir_name = format!(
        "{}_{}_{}",
        slug(&t.title).chars().take(24).collect::<String>(),
        t.platform,
        &target_id[..8]
    );
    let dir = dest_root.join(dir_name);
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Internal(e.to_string()))?;

    let mut files: Vec<String> = Vec::new();

    // video
    let ext = export.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let video_name = format!("video.{ext}");
    link_or_copy(&export, &dir.join(&video_name))?;
    files.push(video_name);

    // thumbnail (optional — honest if absent)
    if let Some(tp) = &t.thumbnail_path {
        let tp = PathBuf::from(tp);
        if tp.exists() {
            let text = tp.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
            let name = format!("thumbnail.{text}");
            link_or_copy(&tp, &dir.join(&name))?;
            files.push(name);
        }
    }

    // metadata.txt — human-readable, ready to paste.
    let meta_txt = format!(
        "PLATFORM: {platform}\nTITLE: {title}\n\nDESCRIPTION:\n{caption}\n\nHASHTAGS: {tags}\nSCHEDULED: {sched}\nPROJECT: {project}\nREMOTE_ID: {remote}\n",
        platform = t.platform,
        title = t.title,
        caption = t.caption,
        tags = t
            .hashtags
            .iter()
            .map(|h| format!("#{h}"))
            .collect::<Vec<_>>()
            .join(" "),
        sched = t.scheduled_at.clone().unwrap_or_else(|| "—".into()),
        project = t.project_id.clone().unwrap_or_else(|| "—".into()),
        remote = t.platform_post_id.clone().unwrap_or_else(|| "—".into()),
    );
    write_atomic(&dir.join("metadata.txt"), &meta_txt)?;
    files.push("metadata.txt".into());

    // publication.json — machine-readable mirror.
    let pub_json = serde_json::json!({
        "packetVersion": 1,
        "platform": t.platform,
        "postId": t.post_id,
        "targetId": target_id,
        "title": t.title,
        "description": t.caption,
        "hashtags": t.hashtags,
        "scheduledAt": t.scheduled_at,
        "projectId": t.project_id,
        "versionId": t.version_id,
        "platformMeta": t.meta,
        "platformPostId": t.platform_post_id,
        "files": files,
    });
    write_atomic(
        &dir.join("publication.json"),
        &serde_json::to_string_pretty(&pub_json).map_err(|e| AppError::Internal(e.to_string()))?,
    )?;
    files.push("publication.json".into());

    // Register.
    let id = uuid::Uuid::new_v4().to_string();
    db.with(|c| {
        c.execute(
            "INSERT INTO publish_packets(id,target_id,dir_path,files_json)
             VALUES(?1,?2,?3,?4)",
            params![
                id,
                target_id,
                dir.to_string_lossy().to_string(),
                serde_json::to_string(&files).unwrap_or_default()
            ],
        )?;
        Ok(())
    })?;
    Ok(PacketRow {
        id,
        target_id: target_id.into(),
        dir_path: dir.to_string_lossy().to_string(),
        files,
        created_at: String::new(),
    })
}

/// Export one packet.
#[tauri::command]
pub fn export_publish_packet(
    db: State<'_, Arc<Db>>,
    target_id: String,
    dest_dir: String,
) -> CmdResult<PacketRow> {
    build_packet(&db, &target_id, Path::new(&dest_dir))
}

/// Batch export — one folder per target, errors per-target so one bad
/// target doesn't kill the batch.
#[tauri::command]
pub fn export_publish_packets(
    db: State<'_, Arc<Db>>,
    target_ids: Vec<String>,
    dest_dir: String,
) -> CmdResult<serde_json::Value> {
    let root = Path::new(&dest_dir);
    let mut ok = Vec::new();
    let mut errs = Vec::new();
    for tid in &target_ids {
        match build_packet(&db, tid, root) {
            Ok(row) => ok.push(row.dir_path),
            Err(e) => errs.push(format!("{tid}: {e}")),
        }
    }
    Ok(serde_json::json!({"exported": ok, "errors": errs}))
}

/// List registered packets (optionally for one target).
#[tauri::command]
pub fn list_publish_packets(
    db: State<'_, Arc<Db>>,
    target_id: Option<String>,
) -> CmdResult<Vec<PacketRow>> {
    db.with(|conn| {
        let (sql, args): (&str, Vec<String>) = match &target_id {
            Some(t) => (
                "SELECT id,target_id,dir_path,files_json,created_at
                 FROM publish_packets WHERE target_id=?1 ORDER BY created_at DESC",
                vec![t.clone()],
            ),
            None => (
                "SELECT id,target_id,dir_path,files_json,created_at
                 FROM publish_packets ORDER BY created_at DESC LIMIT 200",
                vec![],
            ),
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                let fj: String = r.get(3)?;
                Ok(PacketRow {
                    id: r.get(0)?,
                    target_id: r.get(1)?,
                    dir_path: r.get(2)?,
                    files: serde_json::from_str(&fj).unwrap_or_default(),
                    created_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}
