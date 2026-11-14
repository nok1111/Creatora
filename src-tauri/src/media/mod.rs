pub mod commands;
pub mod probe;

use std::path::PathBuf;
use std::process::Command;

/// Locate a tool binary by name ("ffmpeg"/"ffprobe"): bundled copy under
/// tools/bin next to the exe, repo tools/bin in dev builds, CREATORA_FFMPEG/
/// CREATORA_FFPROBE env overrides, then PATH. Never linked — subprocess only
/// (ADR-003).
pub fn tool_path(name: &str) -> Option<PathBuf> {
    let exe_name = format!("{name}.exe");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(dir.join("tools").join("bin").join(&exe_name));
        candidates.push(dir.join(&exe_name));
    }
    if cfg!(debug_assertions) {
        // Dev builds run from src-tauri/target/debug — repo tools/ is 3 up.
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../tools/bin")
                .join(&exe_name),
        );
    }
    let env_key = format!("CREATORA_{}", name.to_uppercase());
    if let Ok(dev) = std::env::var(&env_key) {
        candidates.push(PathBuf::from(dev));
    }
    candidates.push(PathBuf::from(name)); // bare name → PATH resolution

    candidates.into_iter().find(runnable)
}

pub fn ffmpeg_path() -> Option<PathBuf> {
    tool_path("ffmpeg")
}

pub fn ffprobe_path() -> Option<PathBuf> {
    tool_path("ffprobe")
}

fn runnable(path: &PathBuf) -> bool {
    if path.components().count() > 1 && !path.is_file() {
        return false;
    }
    Command::new(path)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `ffmpeg -version` first line, or None if ffmpeg is unavailable.
pub fn ffmpeg_version() -> Option<String> {
    let path = ffmpeg_path()?;
    let out = Command::new(path).arg("-version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout);
    let line = line.lines().next()?.trim().to_string();
    // "ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright ..." ->
    // "9.0.2 (essentials build)" — a readable version, not raw cli output.
    let ver = line
        .strip_prefix("ffmpeg version ")
        .unwrap_or(&line)
        .split_whitespace()
        .next()
        .unwrap_or(&line);
    let (num, tag) = match ver.split_once('-') {
        Some((n, t)) => (n, t.split('-').next().unwrap_or(t).replace('_', " ")),
        None => (ver, String::new()),
    };
    Some(if tag.is_empty() {
        num.to_string()
    } else {
        format!("{num} ({tag})")
    })
}
