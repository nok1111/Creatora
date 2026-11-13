//! ffprobe subprocess → typed media info (never linked libraries).

use crate::error::AppError;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<i64>,
    pub fps_num: Option<u32>,
    pub fps_den: Option<u32>,
    pub codec: Option<String>,
    pub audio_codec: Option<String>,
    pub has_video: bool,
    pub has_audio: bool,
    pub raw: serde_json::Value,
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: ProbeFormat,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
}

#[derive(Deserialize, Default)]
struct ProbeFormat {
    duration: Option<String>,
}

fn parse_fps(rate: &str) -> Option<(u32, u32)> {
    let mut parts = rate.split('/');
    let num: u32 = parts.next()?.parse().ok()?;
    let den: u32 = parts.next().unwrap_or("1").parse().ok()?;
    if num == 0 || den == 0 {
        return None;
    }
    Some((num, den))
}

pub fn probe(path: &Path) -> Result<MediaInfo, AppError> {
    let ffprobe = super::ffprobe_path().ok_or_else(|| {
        AppError::Internal(
            "ffprobe not found — install FFmpeg or set CREATORA_FFPROBE".into(),
        )
    })?;
    run_probe(&ffprobe, path)
}

fn run_probe(ffprobe: &PathBuf, path: &Path) -> Result<MediaInfo, AppError> {
    let out = Command::new(ffprobe)
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|e| AppError::Io(format!("spawn ffprobe: {e}")))?;
    if !out.status.success() {
        return Err(AppError::InvalidInput(format!(
            "ffprobe failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("")
        )));
    }
    let raw: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Internal(format!("parse ffprobe output: {e}")))?;
    let parsed: ProbeOutput = serde_json::from_value(raw.clone())
        .map_err(|e| AppError::Internal(format!("decode ffprobe output: {e}")))?;

    let video = parsed.streams.iter().find(|s| s.codec_type.as_deref() == Some("video"));
    let audio = parsed.streams.iter().find(|s| s.codec_type.as_deref() == Some("audio"));

    let duration_ms = parsed
        .format
        .duration
        .as_deref()
        .or_else(|| video.and_then(|v| v.duration.as_deref()))
        .or_else(|| audio.and_then(|a| a.duration.as_deref()))
        .and_then(|d| d.parse::<f64>().ok())
        .map(|s| (s * 1000.0).round() as i64);

    let (fps_num, fps_den) = video
        .and_then(|v| v.avg_frame_rate.as_deref())
        .and_then(parse_fps)
        .map(|(n, d)| (Some(n), Some(d)))
        .unwrap_or((None, None));

    Ok(MediaInfo {
        width: video.and_then(|v| v.width),
        height: video.and_then(|v| v.height),
        duration_ms,
        fps_num,
        fps_den,
        codec: video.and_then(|v| v.codec_name.clone()),
        audio_codec: audio.and_then(|a| a.codec_name.clone()),
        has_video: video.is_some(),
        has_audio: audio.is_some(),
        raw,
    })
}

/// Asset kind classification from probe info + extension.
pub fn classify(info: &MediaInfo, path: &Path) -> &'static str {
    if info.has_video {
        "video"
    } else if info.has_audio {
        "audio"
    } else {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tiff" | "svg" => "image",
            "ttf" | "otf" | "woff" | "woff2" => "font",
            "creatora" => "project",
            _ => "graphic",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fractional_fps() {
        assert_eq!(parse_fps("30/1"), Some((30, 1)));
        assert_eq!(parse_fps("30000/1001"), Some((30000, 1001)));
        assert_eq!(parse_fps("25"), Some((25, 1)));
        assert_eq!(parse_fps("0/0"), None);
    }
}
