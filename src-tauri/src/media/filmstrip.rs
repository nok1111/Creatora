//! Filmstrip sprite generation — a single ffmpeg pass renders N evenly
//! spaced source frames into one tiled JPEG that the timeline slices
//! per clip window. Disk-cached by the caller like audio waveforms.

use super::{ffmpeg_path, probe};
use std::path::Path;
use std::process::Command;

/// Default strip layout — enough granularity for any sane zoom level
/// while keeping the JPEG small.
pub const FRAMES: usize = 48;
const TILE_W: u32 = 128;
const TILE_H: u32 = 72;

/// Render `frames` frames spaced across the full source duration into a
/// single `frames x 1` tiled JPEG at `out`.
pub fn filmstrip(path: &Path, out: &Path, frames: usize) -> Result<(), String> {
    let ff = ffmpeg_path().ok_or("ffmpeg not found")?;
    let dur_s = probe::probe(path)
        .ok()
        .and_then(|i| i.duration_ms)
        .filter(|d| *d > 0)
        .unwrap_or(60_000) as f64
        / 1000.0;
    let fps = frames.max(1) as f64 / dur_s;
    let status = Command::new(ff)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &path.to_string_lossy(),
            "-vf",
            &format!(
                "fps={fps:.6},scale={TILE_W}:{TILE_H}:force_original_aspect_ratio=decrease,pad={TILE_W}:{TILE_H}:(ow-iw)/2:(oh-ih)/2,tile={}x1",
                frames.max(1)
            ),
            "-frames:v",
            "1",
            "-q:v",
            "4",
            &out.to_string_lossy(),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !status.status.success() {
        return Err(String::from_utf8_lossy(&status.stderr).into_owned());
    }
    Ok(())
}
