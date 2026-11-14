use crate::db::Db;
use crate::error::{AppError, CmdResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub data_dir: String,
    pub ffmpeg_version: Option<String>,
    pub notices_path: Option<String>,
}

/// THIRD_PARTY_NOTICES lives under tools/ next to the exe (bundled) or in the
/// repo root during dev — same layout as tools/bin.
fn notices_path() -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(dir.join("tools").join("THIRD_PARTY_NOTICES"));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../tools/THIRD_PARTY_NOTICES"),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> CmdResult<AppInfo> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_data_dir: {e}")))?;
    Ok(AppInfo {
        name: "Creatora".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: data_dir.to_string_lossy().into_owned(),
        ffmpeg_version: crate::media::ffmpeg_version(),
        notices_path: notices_path(),
    })
}

#[tauri::command]
pub fn get_settings(db: State<'_, Arc<Db>>) -> CmdResult<HashMap<String, String>> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn set_setting(db: State<'_, Arc<Db>>, key: String, value: String) -> CmdResult<()> {
    if key.is_empty() || key.len() > 128 || value.len() > 8192 {
        return Err(AppError::InvalidInput(
            "setting key/value length out of bounds".into(),
        ));
    }
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    })
}
