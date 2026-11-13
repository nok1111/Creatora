//! Audio analysis — waveform peaks, loudness (EBU R128), silence regions.
//! All local ffmpeg processing; heavy work runs inside jobs (ADR-026).

pub mod commands;

use crate::media::ffmpeg_path;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

fn ff() -> Result<std::path::PathBuf, String> {
    ffmpeg_path().ok_or_else(|| "ffmpeg not provisioned".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    /// Min/max pairs per bucket, −1..1. Length = buckets*2.
    pub peaks: Vec<f32>,
    pub buckets: usize,
    pub duration_ms: i64,
}

/// Decode to mono s16 PCM → per-bucket min/max peaks. `buckets` caps the
/// data size regardless of file length (zoom re-requests finer buckets).
pub fn waveform(path: &Path, buckets: usize) -> Result<Waveform, String> {
    let buckets = buckets.clamp(16, 64_000);
    let out = Command::new(ff()?)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &path.to_string_lossy(),
            "-vn",
            "-ac",
            "1",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let pcm: Vec<i16> = out
        .stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let dur_ms = (pcm.len() as i64 * 1000) / 16_000; // mono @16k? use actual
    let dur_ms = probe_duration_ms(path).unwrap_or(dur_ms.max(0));
    let per = (pcm.len() / buckets).max(1);
    let mut peaks = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let start = b * per;
        if start >= pcm.len() {
            peaks.extend_from_slice(&[0.0, 0.0]);
            continue;
        }
        let end = ((b + 1) * per).min(pcm.len());
        let mut mn = 0i16;
        let mut mx = 0i16;
        for &s in &pcm[start..end] {
            mn = mn.min(s);
            mx = mx.max(s);
        }
        peaks.push(mn as f32 / 32768.0);
        peaks.push(mx as f32 / 32768.0);
    }
    Ok(Waveform {
        peaks,
        buckets,
        duration_ms: dur_ms,
    })
}

fn probe_duration_ms(path: &Path) -> Option<i64> {
    let fp = crate::media::ffprobe_path()?;
    let out = Command::new(fp)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path.to_string_lossy(),
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .map(|s| (s * 1000.0) as i64)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub integrated: f64,
    /// True peak, dBTP.
    pub true_peak: f64,
    /// Loudness range, LU.
    pub lra: f64,
    /// Gating threshold, LUFS.
    pub threshold: f64,
}

/// `loudnorm print_format=json` analysis — parses the JSON block ffmpeg
/// prints to stderr.
pub fn loudness(path: &Path) -> Result<Loudness, String> {
    let out = Command::new(ff()?)
        .args([
            "-hide_banner",
            "-i",
            &path.to_string_lossy(),
            "-af",
            "loudnorm=print_format=json",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let err = String::from_utf8_lossy(&out.stderr);
    let start = err.rfind('{').ok_or("no loudnorm json")?;
    let end = err.rfind('}').ok_or("no loudnorm json")?;
    let v: serde_json::Value =
        serde_json::from_str(&err[start..=end]).map_err(|e| e.to_string())?;
    let num = |k: &str| {
        v[k].as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .ok_or_else(|| format!("missing {k}"))
    };
    Ok(Loudness {
        integrated: num("input_i")?,
        true_peak: num("input_tp")?,
        lra: num("input_lra")?,
        threshold: num("input_thresh")?,
    })
}

/// dB gain needed to hit `target_lufs` integrated (caller decides whether
/// to apply via clip volume — non-destructive).
pub fn gain_to_target(measured: f64, target: f64) -> f64 {
    target - measured
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceRegion {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// `silencedetect` stderr parse → silent regions. noise_db like -35,
/// min_ms minimum silence length.
pub fn detect_silence(
    path: &Path,
    noise_db: f64,
    min_ms: i64,
) -> Result<Vec<SilenceRegion>, String> {
    let out = Command::new(ff()?)
        .args([
            "-hide_banner",
            "-i",
            &path.to_string_lossy(),
            "-af",
            &format!(
                "silencedetect=noise={noise_db}dB:d={:.3}",
                min_ms as f64 / 1000.0
            ),
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let err = String::from_utf8_lossy(&out.stderr);
    let mut regions = Vec::new();
    let mut cur_start: Option<i64> = None;
    for line in err.lines() {
        if let Some(pos) = line.find("silence_start:") {
            let v = line[pos + 14..].trim();
            if let Ok(s) = v.parse::<f64>() {
                cur_start = Some((s * 1000.0) as i64);
            }
        } else if let Some(pos) = line.find("silence_end:") {
            let v = line[pos + 12..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            if let (Ok(e), Some(s)) = (v.parse::<f64>(), cur_start.take()) {
                regions.push(SilenceRegion {
                    start_ms: s,
                    end_ms: (e * 1000.0) as i64,
                });
            }
        }
    }
    // trailing silence to EOF
    if let Some(s) = cur_start.take() {
        if let Some(d) = probe_duration_ms(path) {
            regions.push(SilenceRegion {
                start_ms: s,
                end_ms: d,
            });
        }
    }
    Ok(regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_math() {
        assert_eq!(gain_to_target(-20.0, -14.0), 6.0);
        assert_eq!(gain_to_target(-10.0, -16.0), -6.0);
    }
}
