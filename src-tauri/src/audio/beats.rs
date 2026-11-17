//! Percussive-onset ("beat") detection — local, no ML, no extra crates.
//!
//! Honest scope: this finds percussive HITS (kicks / snares / claps): sharp
//! rises in low-band and high-band energy. It does not estimate tempo or
//! downbeats; the UI labels it "detected hits" and exposes a sync offset
//! and a "every 2nd / 4th" thinning for musical grouping.
//!
//! Pipeline: ffmpeg decodes the window to mono 22.05 kHz s16, split into a
//! kick band (<200 Hz) and a snare/hat band (>1.5 kHz); each gets a 10 ms
//! RMS envelope; onset strength = positive jump of log-energy; a peak counts
//! when it clears an adaptive local-median threshold and a refractory gap.

use crate::media::ffmpeg_path;
use std::path::Path;
use std::process::{Command, Stdio};

const SR: usize = 22_050;
const HOP: usize = SR / 100; // 10 ms

/// Source-time ms of detected hits inside [in_ms, out_ms]. `sensitivity`
/// 0..1 (higher = more hits).
pub fn detect_beats(path: &Path, in_ms: i64, out_ms: i64, sensitivity: f64) -> Result<Vec<f64>, String> {
    let ff = ffmpeg_path().ok_or("ffmpeg not provisioned")?;
    let dur = ((out_ms - in_ms).max(0) as f64) / 1000.0;
    let mut cmd = Command::new(ff);
    cmd.args(["-v", "error", "-nostdin", "-ss", &format!("{:.3}", in_ms.max(0) as f64 / 1000.0)]);
    if dur > 0.0 {
        cmd.args(["-t", &format!("{dur:.3}")]);
    }
    cmd.args(["-i"]).arg(path).args(["-vn", "-ac", "1", "-ar", &SR.to_string(), "-f", "s16le", "-"]);
    let out = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !out.status.success() || out.stdout.len() < HOP * 4 {
        return Ok(Vec::new()); // no audio / too short: nothing to react to
    }
    let pcm: Vec<f32> = out
        .stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    Ok(onsets(&pcm, sensitivity).into_iter().map(|t| in_ms.max(0) as f64 + t).collect())
}

/// One-pole low/high split → per-hop RMS envelopes.
fn band_envelopes(pcm: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let a_lo = 1.0 - (-2.0 * std::f32::consts::PI * 200.0 / SR as f32).exp();
    let a_hi = 1.0 - (-2.0 * std::f32::consts::PI * 1500.0 / SR as f32).exp();
    let (mut lo, mut hp_lp) = (0f32, 0f32);
    let n = pcm.len() / HOP;
    let (mut e_lo, mut e_hi) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for h in 0..n {
        let (mut s_lo, mut s_hi) = (0f32, 0f32);
        for &x in &pcm[h * HOP..(h + 1) * HOP] {
            lo += a_lo * (x - lo);
            hp_lp += a_hi * (x - hp_lp);
            let hi = x - hp_lp;
            s_lo += lo * lo;
            s_hi += hi * hi;
        }
        e_lo.push((s_lo / HOP as f32).sqrt());
        e_hi.push((s_hi / HOP as f32).sqrt());
    }
    (e_lo, e_hi)
}

/// Onset times in ms relative to the start of `pcm`.
pub fn onsets(pcm: &[f32], sensitivity: f64) -> Vec<f64> {
    let (lo, hi) = band_envelopes(pcm);
    let n = lo.len();
    if n < 8 {
        return Vec::new();
    }
    // onset strength: positive jump of log energy over a short lookback
    let flux = |e: &[f32], i: usize| -> f32 {
        let prev = (i.saturating_sub(3)..i).map(|j| e[j]).fold(0f32, f32::max);
        ((e[i] + 1e-4).ln() - (prev + 1e-4).ln()).max(0.0)
    };
    let strength: Vec<f32> = (0..n).map(|i| flux(&lo, i).max(flux(&hi, i) * 0.8)).collect();
    // adaptive threshold: local median over ±0.75 s plus a margin
    let sens = sensitivity.clamp(0.0, 1.0) as f32;
    let margin = 1.6 - 1.2 * sens; // sens 0 → 1.6, sens 1 → 0.4
    let floor = 0.35;
    let win = 75;
    let mut out: Vec<f64> = Vec::new();
    let mut last = f64::MIN;
    for i in 1..n.saturating_sub(1) {
        let s = strength[i];
        if s < floor || s < strength[i - 1] || s < strength[i + 1] {
            continue; // not a local peak
        }
        let (a, b) = (i.saturating_sub(win), (i + win).min(n));
        let mut w: Vec<f32> = strength[a..b].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let med = w[w.len() / 2];
        if s < med + margin {
            continue;
        }
        let t = i as f64 * 10.0;
        if t - last >= 220.0 {
            out.push(t);
            last = t;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic kick: 60 Hz sine burst with fast decay every 500 ms.
    fn kick_track(secs: f64, period_ms: f64) -> Vec<f32> {
        let n = (secs * SR as f64) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / SR as f64;
                let since = (t * 1000.0) % period_ms / 1000.0;
                ((2.0 * std::f64::consts::PI * 60.0 * since).sin() * (-since * 18.0).exp() * 0.9) as f32
            })
            .collect()
    }

    #[test]
    fn finds_every_kick_once() {
        let pcm = kick_track(8.0, 500.0);
        let hits = onsets(&pcm, 0.5);
        // 16 kicks (t=0 may be missed: no lookback context)
        assert!((15..=16).contains(&hits.len()), "{} hits: {hits:?}", hits.len());
        for h in &hits {
            let off = (h % 500.0).min(500.0 - h % 500.0);
            assert!(off <= 50.0, "hit at {h} is {off} ms from a kick");
        }
    }

    #[test]
    fn silence_and_steady_tone_have_no_hits() {
        assert!(onsets(&vec![0.0; SR * 4], 1.0).is_empty());
        let tone: Vec<f32> = (0..SR * 4).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        assert!(onsets(&tone, 1.0).is_empty());
    }

    #[test]
    fn higher_sensitivity_never_finds_fewer_hits() {
        let pcm = kick_track(6.0, 400.0);
        assert!(onsets(&pcm, 0.9).len() >= onsets(&pcm, 0.1).len());
    }
}
