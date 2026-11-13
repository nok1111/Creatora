//! `.creatora` file IO: atomic save (tmp + rename), open, autosave + recovery.

use crate::error::AppError;
use crate::project::document::{now_iso, ProjectDoc};
use std::path::{Path, PathBuf};

pub const PROJECT_EXT: &str = "creatora";

/// Windows-safe file stem for a project name.
pub fn sanitize_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = clean.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed
    }
}

pub fn project_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{}.{PROJECT_EXT}", sanitize_filename(name)))
}

/// Atomic-ish save: write to sibling tmp file, then rename over the target.
/// A crash mid-write leaves the previous good file intact.
pub fn save(path: &Path, doc: &ProjectDoc) -> Result<(), AppError> {
    let mut doc = doc.clone();
    doc.meta.modified_at = now_iso();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("creatora.tmp");
    let json = serde_json::to_string_pretty(&doc)
        .map_err(|e| AppError::Internal(format!("serialize project: {e}")))?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn open(path: &Path) -> Result<ProjectDoc, AppError> {
    if !path.is_file() {
        return Err(AppError::NotFound(format!(
            "project file not found: {}",
            path.display()
        )));
    }
    let json = std::fs::read_to_string(path)?;
    ProjectDoc::parse(&json)
}

/// Autosave target: `<data_dir>/autosaves/<project_id>.creatora`.
pub fn autosave_path(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir
        .join("autosaves")
        .join(format!("{}.creatora", sanitize_filename(project_id)))
}

pub fn save_autosave(data_dir: &Path, doc: &ProjectDoc) -> Result<PathBuf, AppError> {
    let path = autosave_path(data_dir, &doc.meta.id);
    save(&path, doc)?;
    Ok(path)
}

/// Recovery candidate: autosave exists and is newer than the project file
/// (or the project file is missing entirely).
pub fn find_recovery(data_dir: &Path, project_id: &str, project_file: &Path) -> Option<PathBuf> {
    let auto = autosave_path(data_dir, project_id);
    if !auto.is_file() {
        return None;
    }
    let auto_mtime = mtime(&auto).unwrap_or(0);
    let proj_mtime = mtime(project_file).unwrap_or(0);
    if auto_mtime > proj_mtime {
        Some(auto)
    } else {
        None
    }
}

fn mtime(path: &Path) -> Option<u128> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
}

pub fn discard_autosave(data_dir: &Path, project_id: &str) {
    let auto = autosave_path(data_dir, project_id);
    if auto.is_file() {
        let _ = std::fs::remove_file(auto);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::document::Canvas;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("creatora-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn doc() -> ProjectDoc {
        ProjectDoc::new(
            "my project",
            Canvas {
                width: 1280,
                height: 720,
                fps_num: 30,
                fps_den: 1,
                background: "#000".into(),
            },
        )
    }

    #[test]
    fn save_then_open_round_trips() {
        let dir = tmpdir();
        let path = project_path(&dir, "my project");
        save(&path, &doc()).unwrap();
        let loaded = open(&path).unwrap();
        assert_eq!(loaded.meta.name, "my project");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_missing_is_not_found() {
        let dir = tmpdir();
        let err = open(&dir.join("nope.creatora")).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn autosave_recovery_detected_when_newer() {
        let dir = tmpdir();
        let d = doc();
        let proj = project_path(&dir, "my project");
        save(&proj, &d).unwrap();
        // Ensure autosave mtime is strictly newer.
        std::thread::sleep(std::time::Duration::from_millis(5));
        save_autosave(&dir, &d).unwrap();
        let rec = find_recovery(&dir, &d.meta.id, &proj);
        assert!(rec.is_some());
        discard_autosave(&dir, &d.meta.id);
        assert!(find_recovery(&dir, &d.meta.id, &proj).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sanitizes_windows_illegal_chars() {
        assert_eq!(
            sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"),
            "a b c d e f g h i j"
        );
        assert_eq!(sanitize_filename("  .  "), "untitled");
        assert_eq!(sanitize_filename(""), "untitled");
    }
}
