use std::path::PathBuf;
use std::process::Command;

/// Locate ffmpeg: bundled copy under tools/bin next to the exe first,
/// then CREATORA_FFMPEG env override, then PATH. Never embeds or links
/// ffmpeg — subprocess only (ADR-003).
pub fn ffmpeg_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(dir.join("tools").join("bin").join("ffmpeg.exe"));
        candidates.push(dir.join("ffmpeg.exe"));
    }
    if let Ok(dev) = std::env::var("CREATORA_FFMPEG") {
        candidates.push(PathBuf::from(dev));
    }
    candidates.push(PathBuf::from("ffmpeg")); // bare name → PATH resolution

    candidates.into_iter().find(runnable)
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
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
}
