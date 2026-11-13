//! Smart reframe analysis — local subject tracking, no ML models, no APIs.
//!
//! Strategy (ADR-023): decode the clip's source window to small grayscale
//! frames via ffmpeg, compute the centroid of frame-to-frame *change*
//! (motion energy). When a clip has no significant motion, fall back to a
//! luminance centroid — a cheap saliency proxy — and mark samples
//! `motion: false` so the UI can say "static framing".
//!
//! Output is normalized source coords (0..1) per sample; the frontend maps
//! them to transform keyframes via `defaultReframe`. Manual correction is
//! always possible — these are just keyframes the user can edit.
//!
//! Honest scope: this tracks *moving* subjects and bright salience, not
//! semantic objects/faces. Face/object tracking (e.g. ONNX face detector)
//! is a documented future option — model size/license noted in
//! DEVELOPMENT_PLAN.md Phase 4 notes.

use crate::error::AppError;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionSample {
    /// ms relative to the clip's source window start.
    pub t_ms: i64,
    /// Centroid in normalized source coords (0..1).
    pub cx: f64,
    pub cy: f64,
    /// Mean |diff| energy — ~0 for static frames.
    pub energy: f64,
    /// Whether this sample came from motion (vs. luma fallback).
    pub motion: bool,
}

/// Sample `n` frames across [in_ms, out_ms] of `path` and track the
/// activity centroid. Returns at least one sample (center fallback).
pub fn analyze_motion(
    path: &Path,
    in_ms: i64,
    out_ms: i64,
    n: u32,
) -> Result<Vec<MotionSample>, AppError> {
    let ffmpeg =
        crate::media::ffmpeg_path().ok_or_else(|| AppError::Internal("ffmpeg not found".into()))?;
    let meta = crate::media::probe::probe(path)?;
    let (sw, sh) = (
        meta.width.unwrap_or(1).max(1) as usize,
        meta.height.unwrap_or(1).max(1) as usize,
    );
    let dur = (out_ms - in_ms).max(1) as f64 / 1000.0;
    let n = n.clamp(2, 64);
    let fps = n as f64 / dur;

    // Decode: small gray frames keep memory bounded (96px wide).
    let ow = 96usize;
    let oh = ((sh as f64 * ow as f64 / sw as f64) / 2.0).round() as usize * 2;
    let oh = oh.max(2);
    let mut child = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{:.3}", in_ms as f64 / 1000.0),
            "-i",
            &path.to_string_lossy(),
            "-t",
            &format!("{dur:.3}"),
            "-vf",
            &format!("fps={fps:.4},scale={ow}:{oh}"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::Internal(format!("spawn ffmpeg: {e}")))?;

    let mut raw = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut raw)
        .map_err(|e| AppError::Internal(format!("read ffmpeg: {e}")))?;
    let _ = child.wait();

    let fsz = ow * oh;
    let nframes = raw.len() / fsz;
    if nframes == 0 {
        return Ok(vec![MotionSample {
            t_ms: 0,
            cx: 0.5,
            cy: 0.5,
            energy: 0.0,
            motion: false,
        }]);
    }

    let mut out = Vec::with_capacity(nframes);
    let frame_ms = out_ms - in_ms;
    for i in 0..nframes {
        let f = &raw[i * fsz..(i + 1) * fsz];
        // Motion centroid vs previous frame.
        let (mut mx, mut my, mut wsum) = (0.0f64, 0.0f64, 0.0f64);
        if i > 0 {
            let p = &raw[(i - 1) * fsz..i * fsz];
            for y in 0..oh {
                for x in 0..ow {
                    let d = (f[y * ow + x] as i32 - p[y * ow + x] as i32).abs();
                    if d > 24 {
                        // ignore noise
                        mx += x as f64 * d as f64;
                        my += y as f64 * d as f64;
                        wsum += d as f64;
                    }
                }
            }
        }
        let energy = wsum / (fsz as f64 * 255.0);
        let (cx, cy, motion) = if wsum > fsz as f64 * 2.0 {
            (mx / wsum, my / wsum, true)
        } else {
            // Luma-centroid fallback (static scene saliency).
            let (mut lx, mut ly, mut lw) = (0.0f64, 0.0f64, 0.0f64);
            for y in 0..oh {
                for x in 0..ow {
                    let v = f[y * ow + x] as f64;
                    lx += x as f64 * v;
                    ly += y as f64 * v;
                    lw += v;
                }
            }
            if lw > 1.0 {
                (lx / lw, ly / lw, false)
            } else {
                (0.5, 0.5, false)
            }
        };
        out.push(MotionSample {
            t_ms: (i as f64 / fps * 1000.0).min(frame_ms as f64) as i64,
            cx: (cx / ow as f64).clamp(0.0, 1.0),
            cy: (cy / oh as f64).clamp(0.0, 1.0),
            energy,
            motion,
        });
    }
    Ok(out)
}
