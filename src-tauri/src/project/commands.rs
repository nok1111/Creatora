use crate::db::Db;
use crate::error::{AppError, CmdResult};
use crate::project::{document, store};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub is_favorite: bool,
    pub is_archived: bool,
    pub modified_at: String,
    pub last_opened_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResult {
    pub doc: document::ProjectDoc,
    pub file_path: String,
    /// Set when a newer autosave exists — UI offers recovery instead of auto-replacing.
    pub recovery_path: Option<String>,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_data_dir: {e}")))
}

fn projects_dir(app: &tauri::AppHandle, db: &Db) -> Result<PathBuf, AppError> {
    let custom = db.with(|c| {
        Ok(c.query_row(
            "SELECT value FROM settings WHERE key = 'project.defaultDir'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok())
    })?;
    if let Some(dir) = custom.filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| AppError::Internal(format!("resolve document_dir: {e}")))?;
    Ok(docs.join("Creatora").join("Projects"))
}

/// Pick a non-colliding project file path in `dir` for `name`.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let base = store::project_path(dir, name);
    if !base.exists() {
        return base;
    }
    let stem = store::sanitize_filename(name);
    for i in 2..10_000 {
        let candidate = dir.join(format!("{stem} {i}.{}", store::PROJECT_EXT));
        if !candidate.exists() {
            return candidate;
        }
    }
    base // unreachable in practice
}

fn upsert_catalog(db: &Db, doc: &document::ProjectDoc, path: &Path) -> Result<(), AppError> {
    db.with(|c| {
        c.execute(
            "INSERT INTO projects (id, name, file_path, width, height, fps_num, fps_den,
                                   source_project_id, created_at, modified_at, last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                file_path = excluded.file_path,
                width = excluded.width,
                height = excluded.height,
                fps_num = excluded.fps_num,
                fps_den = excluded.fps_den,
                modified_at = excluded.modified_at,
                last_opened_at = excluded.last_opened_at",
            rusqlite::params![
                doc.meta.id,
                doc.meta.name,
                path.to_string_lossy(),
                doc.canvas.width as i64,
                doc.canvas.height as i64,
                doc.canvas.fps_num as i64,
                doc.canvas.fps_den as i64,
                doc.meta.source_project_id,
                doc.meta.created_at,
                doc.meta.modified_at,
            ],
        )?;
        Ok(())
    })
}

fn row_to_summary(r: &rusqlite::Row) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        file_path: r.get(2)?,
        thumbnail_path: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        is_favorite: r.get::<_, i64>(6)? != 0,
        is_archived: r.get::<_, i64>(7)? != 0,
        modified_at: r.get(8)?,
        last_opened_at: r.get(9)?,
    })
}

const SUMMARY_COLS: &str =
    "id, name, file_path, thumbnail_path, width, height, is_favorite, is_archived, modified_at, last_opened_at";

#[tauri::command]
pub fn list_projects(db: State<'_, Arc<Db>>, include_archived: Option<bool>) -> CmdResult<Vec<ProjectSummary>> {
    let include_archived = include_archived.unwrap_or(false);
    db.with(|c| {
        let sql = format!(
            "SELECT {SUMMARY_COLS} FROM projects {} ORDER BY COALESCE(last_opened_at, modified_at) DESC",
            if include_archived { "" } else { "WHERE is_archived = 0" }
        );
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_summary)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn create_project(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    name: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
) -> CmdResult<OpenProjectResult> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput("project name is required".into()));
    }
    if width == 0 || height == 0 || fps_num == 0 || fps_den == 0 {
        return Err(AppError::InvalidInput(
            "canvas dimensions and fps must be non-zero".into(),
        ));
    }
    let dir = projects_dir(&app, &db)?;
    let path = unique_path(&dir, name.trim());
    let doc = document::ProjectDoc::new(
        name.trim(),
        document::Canvas {
            width,
            height,
            fps_num,
            fps_den,
            background: "#000000".into(),
        },
    );
    store::save(&path, &doc)?;
    upsert_catalog(&db, &doc, &path)?;
    Ok(OpenProjectResult {
        doc,
        file_path: path.to_string_lossy().into_owned(),
        recovery_path: None,
    })
}

#[tauri::command]
pub fn open_project(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    path: String,
) -> CmdResult<OpenProjectResult> {
    let path = PathBuf::from(&path);
    let mut doc = store::open(&path)?;
    resolve_media_paths(&mut doc, &path);
    upsert_catalog(&db, &doc, &path)?;
    let recovery = store::find_recovery(&data_dir(&app)?, &doc.meta.id, &path)
        .map(|p| p.to_string_lossy().into_owned());
    Ok(OpenProjectResult {
        doc,
        file_path: path.to_string_lossy().into_owned(),
        recovery_path: recovery,
    })
}

/// When a project was moved as a bundle (media/ sibling dir), refs whose
/// stored absolute path vanished get rewritten to the bundled copy.
/// Skipped refs stay as-is so the missing-media UI reports them honestly.
fn resolve_media_paths(doc: &mut document::ProjectDoc, project_file: &Path) {
    let Some(dir) = project_file.parent() else { return };
    let bundle_media = dir.join("media");
    if !bundle_media.is_dir() {
        return;
    }
    for m in &mut doc.media_refs {
        if Path::new(&m.path).is_file() {
            continue;
        }
        let Some(name) = Path::new(&m.path).file_name() else { continue };
        let candidate = bundle_media.join(name);
        if candidate.is_file() {
            m.path = candidate.to_string_lossy().into_owned();
        }
    }
}

#[tauri::command]
pub fn save_project(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    path: String,
    doc: document::ProjectDoc,
) -> CmdResult<()> {
    let path = PathBuf::from(&path);
    store::save(&path, &doc)?;
    upsert_catalog(&db, &doc, &path)?;
    sync_usage(&db, &doc)?;
    store::discard_autosave(&data_dir(&app)?, &doc.meta.id);
    Ok(())
}

/// Keep `project_asset` usage refs in sync with the doc's media_refs —
/// powers "used by" lookups and missing-media impact analysis.
fn sync_usage(db: &Db, doc: &document::ProjectDoc) -> Result<(), AppError> {
    db.with(|c| {
        c.execute(
            "DELETE FROM project_asset WHERE project_id = ?1",
            [&doc.meta.id],
        )?;
        for m in &doc.media_refs {
            c.execute(
                "INSERT OR IGNORE INTO project_asset (project_id, asset_id) VALUES (?1, ?2)",
                [&doc.meta.id, &m.asset_id],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn autosave_project(app: tauri::AppHandle, doc: document::ProjectDoc) -> CmdResult<()> {
    store::save_autosave(&data_dir(&app)?, &doc)?;
    Ok(())
}

/// Open the autosave copy (user accepted recovery) without touching the file.
#[tauri::command]
pub fn recover_project(app: tauri::AppHandle, project_id: String) -> CmdResult<document::ProjectDoc> {
    let auto = store::autosave_path(&data_dir(&app)?, &project_id);
    store::open(&auto)
}

#[tauri::command]
pub fn discard_recovery(app: tauri::AppHandle, project_id: String) -> CmdResult<()> {
    store::discard_autosave(&data_dir(&app)?, &project_id);
    Ok(())
}

#[tauri::command]
pub fn set_project_flag(
    db: State<'_, Arc<Db>>,
    id: String,
    favorite: Option<bool>,
    archived: Option<bool>,
) -> CmdResult<()> {
    db.with(|c| {
        let mut sets = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(f) = favorite {
            sets.push("is_favorite = ?");
            vals.push(Box::new(f as i64));
        }
        if let Some(a) = archived {
            sets.push("is_archived = ?");
            vals.push(Box::new(a as i64));
        }
        if sets.is_empty() {
            return Ok(());
        }
        vals.push(Box::new(id));
        let sql = format!(
            "UPDATE projects SET {} WHERE id = ?{}",
            sets.join(", "),
            vals.len()
        );
        let params: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
        c.execute(&sql, params.as_slice())?;
        Ok(())
    })
}

#[tauri::command]
pub fn duplicate_project(
    db: State<'_, Arc<Db>>,
    id: String,
) -> CmdResult<OpenProjectResult> {
    let (name, file_path) = db.with(|c| {
        c.query_row(
            "SELECT name, file_path FROM projects WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(AppError::from)
    })?;
    let src = PathBuf::from(&file_path);
    let mut doc = store::open(&src)?;
    doc.meta.id = uuid::Uuid::new_v4().to_string();
    doc.meta.name = format!("{name} copy");
    doc.meta.created_at = document::now_iso();
    let dir = src.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
    let path = unique_path(&dir, &doc.meta.name);
    store::save(&path, &doc)?;
    upsert_catalog(&db, &doc, &path)?;
    Ok(OpenProjectResult {
        doc,
        file_path: path.to_string_lossy().into_owned(),
        recovery_path: None,
    })
}

/// Remove from catalog; optionally delete the file (UI asks user explicitly).
#[tauri::command]
pub fn delete_project(
    app: tauri::AppHandle,
    db: State<'_, Arc<Db>>,
    id: String,
    delete_file: bool,
) -> CmdResult<()> {
    let file_path = db.with(|c| {
        c.query_row(
            "SELECT file_path FROM projects WHERE id = ?1",
            [&id],
            |r| r.get::<_, String>(0),
        )
        .map_err(AppError::from)
    })?;
    db.with(|c| {
        c.execute("DELETE FROM projects WHERE id = ?1", [&id])?;
        Ok(())
    })?;
    if delete_file {
        let p = PathBuf::from(&file_path);
        if p.is_file() {
            std::fs::remove_file(&p)?;
        }
    }
    store::discard_autosave(&data_dir(&app)?, &id);
    Ok(())
}

/// Export a self-contained bundle: `<dest>/<name>/project.creatora` +
/// `<dest>/<name>/media/<files>` + manifest. Media is consolidated by copy —
/// referenced files found missing are skipped and reported.
#[tauri::command]
pub fn export_project_bundle(
    db: State<'_, Arc<Db>>,
    id: String,
    dest_dir: String,
) -> CmdResult<serde_json::Value> {
    let (name, file_path) = db.with(|c| {
        c.query_row(
            "SELECT name, file_path FROM projects WHERE id = ?1",
            [&id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(AppError::from)
    })?;
    let doc = store::open(&PathBuf::from(&file_path))?;

    let dest = PathBuf::from(&dest_dir);
    let stem = store::sanitize_filename(&format!("{name}-bundle"));
    let mut bundle_dir = dest.join(&stem);
    for i in 2..10_000 {
        if !bundle_dir.exists() {
            break;
        }
        bundle_dir = dest.join(format!("{stem} {i}"));
    }
    let media_dir = bundle_dir.join("media");
    std::fs::create_dir_all(&media_dir)?;

    let mut copied = 0u32;
    let mut missing: Vec<String> = Vec::new();
    let mut new_doc = doc.clone();
    for m in &mut new_doc.media_refs {
        let src = PathBuf::from(&m.path);
        if !src.is_file() {
            missing.push(m.path.clone());
            continue;
        }
        let fname = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{}.bin", m.asset_id));
        let target = unique_media_name(&media_dir, &fname);
        std::fs::copy(&src, &target)?;
        m.path = target.to_string_lossy().into_owned();
        copied += 1;
    }

    let project_file = bundle_dir.join(format!("{}.{}", store::sanitize_filename(&name), store::PROJECT_EXT));
    store::save(&project_file, &new_doc)?;

    let manifest = serde_json::json!({
        "bundleVersion": 1,
        "project": name,
        "projectFile": project_file.file_name().unwrap().to_string_lossy(),
        "mediaCopied": copied,
        "mediaMissing": missing,
        "createdAt": document::now_iso(),
    });
    std::fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )?;

    Ok(serde_json::json!({
        "bundleDir": bundle_dir.to_string_lossy(),
        "mediaCopied": copied,
        "mediaMissing": missing,
    }))
}

fn unique_media_name(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..10_000 {
        let c = dir.join(format!("{stem}-{i}{ext}"));
        if !c.exists() {
            return c;
        }
    }
    p
}
