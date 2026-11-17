//! Library effects (shared/fx manifest, `kind: "effect"`) → ffmpeg filters.
//!
//! Every effect is built from cheap NATIVE filters whose parameters are
//! animated per frame:
//!  - `sendcmd` + a runtime-commandable filter (`rgbashift@name`) for
//!    values that change every frame (RGB split envelopes);
//!  - expression-driven `zoompan` / `eq` (evaluated once per FRAME, not per
//!    pixel) for zoom and exposure curves.
//! The curves are plain closed-form functions mirrored 1:1 in
//! `src/lib/fx/envelopes.ts`, so the preview evaluates the same numbers.
//!
//! Beat-driven envelopes use a balanced `if` tree over the beat times so the
//! expression depth is O(log n) (a linear nest overflows ffmpeg's evaluator
//! stack on long clips).

use super::{fxlib, fxlut};
use crate::project::document::Effect;
#[cfg(test)]
use std::collections::BTreeMap;

/// Geometry/timing the effect curves need.
#[derive(Debug, Clone)]
pub struct FxCtx {
    pub w: u32,
    pub h: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Clip duration on the timeline (ms).
    pub clip_ms: i64,
    pub source_in_ms: i64,
    pub speed: f64,
}

impl Default for FxCtx {
    fn default() -> Self {
        FxCtx { w: 1920, h: 1080, fps_num: 30, fps_den: 1, clip_ms: 0, source_in_ms: 0, speed: 1.0 }
    }
}

impl FxCtx {
    fn fps(&self) -> f64 {
        self.fps_num as f64 / self.fps_den.max(1) as f64
    }
    fn fps_str(&self) -> String {
        format!("{}/{}", self.fps_num, self.fps_den)
    }
}

/// Max per-frame commands emitted for one effect (guards pathological clips).
const MAX_FRAMES: usize = 36_000;

// ── closed-form curves (mirrored in src/lib/fx/envelopes.ts) ──────────

pub fn round_half_up(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// 2^(-10u) normalised so g(0)=1 and g(1)=0 exactly (continuity at the end).
pub fn expo_decay(u: f64) -> f64 {
    const K: f64 = 0.0009765625; // 2^-10
    ((2f64.powf(-10.0 * u.clamp(0.0, 1.0)) - K) / (1.0 - K)).max(0.0)
}

/// RGB-displacement envelope 0..1. mode: 0 static, 1 pulse, 2 glitch.
pub fn rgb_env(mode: u8, speed: f64, t: f64) -> f64 {
    match mode {
        0 => 1.0,
        1 => (std::f64::consts::PI * speed * t).cos().abs().powi(3),
        _ => {
            let slot = (t * speed * 2.0).floor();
            let h = (slot * 0.6180339887498949).rem_euclid(1.0);
            if h < 0.55 {
                0.15
            } else {
                0.15 + 0.85 * ((h - 0.55) / 0.45)
            }
        }
    }
}

/// Integer (rh, rv) red shift for the effect at time `t`; blue gets the
/// negation. `width` is the canvas width in px.
pub fn rgb_shift(amount_pct: f64, angle_deg: f64, env: f64, width: f64) -> (i32, i32) {
    let px = amount_pct / 100.0 * width * env;
    let a = angle_deg.to_radians();
    (round_half_up(px * a.cos()) as i32, round_half_up(px * a.sin()) as i32)
}

// ── helpers ───────────────────────────────────────────────────────────

fn attr_name(e: &Effect, tag: &str) -> String {
    let id: String = e.id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    format!("{tag}{id}")
}

/// Clip-relative activation window in seconds (None edge = unbounded).
fn window_s(e: &Effect) -> (f64, f64) {
    (
        e.in_ms.map_or(0.0, |v| v / 1000.0),
        e.out_ms.map_or(f64::INFINITY, |v| v / 1000.0),
    )
}

/// `between(var,a,b)` gate expression, or "1" when the effect is unbounded.
fn gate(e: &Effect, var: &str) -> String {
    match (e.in_ms, e.out_ms) {
        (None, None) => "1".into(),
        (a, b) => format!(
            "between({var},{},{})",
            a.map_or(0.0, |v| v / 1000.0),
            b.map_or(1.0e9, |v| v / 1000.0)
        ),
    }
}

/// `sendcmd` driving a named rgbashift, one command per CHANGED frame.
/// `f(t)` → (rh, rv). Blue mirrors red. Outside the window → 0.
fn rgb_split_cmds(e: &Effect, ctx: &FxCtx, name: &str, f: impl Fn(f64) -> (i32, i32)) -> Vec<String> {
    let (w0, w1) = window_s(e);
    let n = ((ctx.clip_ms as f64 / 1000.0) * ctx.fps()).ceil().max(1.0) as usize;
    let mut cmds: Vec<String> = Vec::new();
    let mut last = (i32::MAX, i32::MAX);
    for k in 0..n.min(MAX_FRAMES) {
        let t = k as f64 / ctx.fps();
        let cur = if t >= w0 && t < w1 { f(t) } else { (0, 0) };
        if cur != last {
            cmds.push(format!(
                "{t:.4} rgbashift@{name} rh {},rgbashift@{name} rv {},rgbashift@{name} bh {},rgbashift@{name} bv {}",
                cur.0, cur.1, -cur.0, -cur.1
            ));
            last = cur;
        }
    }
    vec![
        format!("sendcmd=c='{}'", cmds.join(";")),
        format!("rgbashift@{name}=rh=0:rv=0:bh=0:bv=0"),
    ]
}

/// Normalise the layer to the canvas (centre-crop if larger — `pad` errors
/// on a bigger input — then pad if smaller) and zoom about the centre with a
/// per-frame `z` expression (`time` = clip-relative seconds).
fn zoom_frag(ctx: &FxCtx, z_expr: &str) -> String {
    format!(
        "crop=w='min(iw,{w})':h='min(ih,{h})',pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,zoompan=z='max(1,{z_expr})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}:fps={fps}",
        w = ctx.w,
        h = ctx.h,
        fps = ctx.fps_str()
    )
}

/// Balanced if-tree: value of `leaf(b)` for the latest beat b ≤ var, else 0.
fn beat_tree(var: &str, beats: &[f64], leaf: &dyn Fn(&str, f64) -> String) -> String {
    fn rec(var: &str, beats: &[f64], lo: usize, hi: usize, leaf: &dyn Fn(&str, f64) -> String) -> String {
        if lo == hi {
            return leaf(var, beats[lo]);
        }
        let mid = (lo + hi + 1) / 2;
        format!(
            "if(lt({var},{:.4}),{},{})",
            beats[mid],
            rec(var, beats, lo, mid - 1, leaf),
            rec(var, beats, mid, hi, leaf)
        )
    }
    format!(
        "if(lt({var},{:.4}),0,{})",
        beats[0],
        rec(var, beats, 0, beats.len() - 1, leaf)
    )
}

/// Beat times (clip-relative seconds) the effect reacts to: source-time
/// detections mapped through trim/speed, shifted by the sync offset and
/// thinned by `every`.
pub fn beat_times(e: &Effect, every: usize, offset_ms: f64, ctx: &FxCtx) -> Vec<f64> {
    let mut v: Vec<f64> = e
        .times
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|src| ((src - ctx.source_in_ms as f64) / ctx.speed.max(0.01) + offset_ms) / 1000.0)
        .filter(|t| *t >= -0.5 && *t <= ctx.clip_ms as f64 / 1000.0)
        .collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.into_iter().enumerate().filter(|(i, _)| i % every.max(1) == 0).map(|(_, t)| t).collect()
}

// ── creative filters (kind:"filter") ─────────────────────────────────
//
// Color identity comes from the baked 33³ .cube (fxlut.rs — same spec the
// preview's GL 3D texture uses, trilinear both sides). Spatial dressing
// (vignette, grain, CA, bloom, halation, sharpen, diffusion) is appended
// as native fragments. All spatial params are canonical 0..1 and scaled
// by `intensity`; at intensity 0 the whole filter disappears.
//
// `split`/`blend` constructs appear inside one fragment — the `;`-linked
// labels are legal inside the clip's comma chain, and a disabled `blend`
// passes its first input, so the effect window still bypasses cleanly.

/// Deterministic .cube path in the temp dir (same text → same file).
fn cube_path(text: &str) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    let dir = std::env::temp_dir().join("creatora-fx");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("lut-{:016x}.cube", h.finish()))
}

/// Path text for a `lut3d=` argument (ffmpeg accepts forward slashes; the
/// drive colon must be escaped, quotes doubled-escaped).
fn esc_filter_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/").replace(':', "\\:")
}

fn filter_fragments(entry: &fxlib::FxEntry, e: &Effect) -> Option<Vec<String>> {
    let p = fxlib::resolve_constants(entry, &e.params);
    let i = (p.get("intensity").copied().unwrap_or(100.0) / 100.0).clamp(0.0, 1.0);
    if i <= 0.0 {
        return None;
    }
    // Library effects gate their own windows (effects.rs doesn't wrap them).
    // For `;`-linked split/blend fragments the enable lands on the trailing
    // blend — a disabled blend passes its first input, so the window still
    // bypasses cleanly.
    let en = match (e.in_ms, e.out_ms) {
        (None, None) => String::new(),
        (a, b) => format!(
            ":enable='between(t,{},{})'",
            fxlib::fmt_num(a.map_or(0.0, |v| v / 1000.0)),
            fxlib::fmt_num(b.map_or(1.0e9, |v| v / 1000.0))
        ),
    };
    let sc = |k: &str| p.get(k).copied().unwrap_or(0.0) * i;
    let mut frags: Vec<String> = Vec::new();

    // 1 — color: baked LUT (skipped for pure-spatial entries).
    if entry.lut.as_ref().is_some_and(|l| !l.is_empty()) {
        let text = fxlut::bake_cube_text(entry, &p);
        let path = cube_path(&text);
        if let Err(err) = std::fs::write(&path, &text) {
            eprintln!("[fx] cannot write LUT {path:?}: {err}");
        } else {
            frags.push(format!("lut3d='{}':interp=trilinear{en}", esc_filter_path(&path)));
        }
    }

    // 2 — chromatic aberration: red/blue diverge horizontally.
    let ca = sc("ca");
    if ca > 0.001 {
        let px = (ca * 6.0).round().max(1.0) as i32;
        frags.push(format!("rgbashift=rh={px}:bh=-{px}{en}"));
    }

    // 3 — bloom: blurred highlights screen-blended back in.
    let bloom = sc("bloom");
    if bloom > 0.001 {
        let (a, b, g) = (
            attr_name(e, "ba"),
            attr_name(e, "bb"),
            attr_name(e, "bg"),
        );
        let sigma = (bloom * 18.0).max(1.0);
        let op = (bloom * 0.85).min(1.0);
        frags.push(format!(
            "split[{a}][{b}];[{b}]gblur=sigma={sigma},curves=all='0/0 0.55/0.08 0.8/0.6 1/1'[{g}];[{a}][{g}]blend=all_mode=screen:all_opacity={op}{en}"
        ));
    }

    // 4 — halation: warm-biased bleed around highlights.
    let hal = sc("hal");
    if hal > 0.001 {
        let (a, b, g) = (
            attr_name(e, "ha"),
            attr_name(e, "hb"),
            attr_name(e, "hg"),
        );
        let sigma = (hal * 8.0).max(1.0);
        let op = (hal * 0.7).min(1.0);
        frags.push(format!(
            "split[{a}][{b}];[{b}]gblur=sigma={sigma},colorchannelmixer=rr=1:rg=0.15:rb=0:gr=0.35:gg=0.6:gb=0.05:br=0.2:bg=0.25:bb=0.5[{g}];[{a}][{g}]blend=all_mode=screen:all_opacity={op}{en}"
        ));
    }

    // 5 — sharpen / diffusion.
    let sharp = sc("sharp");
    if sharp > 0.001 {
        frags.push(format!("unsharp=5:5:{}{en}", fxlib::fmt_num(sharp * 1.4)));
    }
    let soft = sc("soft");
    if soft > 0.001 {
        let (a, b, g) = (
            attr_name(e, "sa"),
            attr_name(e, "sb"),
            attr_name(e, "sg"),
        );
        let sigma = (soft * 3.0).max(0.5);
        let op = (soft * 0.55).min(1.0);
        frags.push(format!(
            "split[{a}][{b}];[{b}]gblur=sigma={sigma}[{g}];[{a}][{g}]blend=all_mode=normal:all_opacity={op}{en}"
        ));
    }

    // 6 — grain, then vignette (dressing on top).
    let grain = sc("grain");
    if grain > 0.001 {
        frags.push(format!("noise=alls={}:allf=t+u{en}", (grain * 28.0).round().max(1.0) as i32));
    }
    let vig = sc("vig");
    if vig > 0.001 {
        frags.push(format!(
            "vignette=angle={}{en}",
            fxlib::fmt_num(vig * std::f64::consts::FRAC_PI_3)
        ));
    }

    (!frags.is_empty()).then_some(frags)
}

// ── effects ───────────────────────────────────────────────────────────

/// Fragments for a library effect, or None when `e` isn't one (legacy
/// kinds fall through to effects.rs) or has nothing to do.
pub fn fragments(e: &Effect, ctx: &FxCtx) -> Option<Vec<String>> {
    let entry = fxlib::entry(&e.kind)?;
    if entry.kind == "filter" {
        return filter_fragments(entry, e);
    }
    if entry.kind != "effect" {
        return None;
    }
    let p = fxlib::resolve_constants(entry, &e.params);
    match e.kind.as_str() {
        "rgbDisplacement" => {
            let (amount, angle, mode, speed) = (p["amount"], p["angle"], p["mode"] as u8, p["speed"]);
            if amount <= 0.0 || ctx.clip_ms <= 0 {
                return None;
            }
            let name = attr_name(e, "rgd");
            let w = ctx.w as f64;
            Some(rgb_split_cmds(e, ctx, &name, |t| rgb_shift(amount, angle, rgb_env(mode, speed, t), w)))
        }
        "heroEntrance" => {
            let (dur, zoom, flash, split) = (p["duration"] / 1000.0, p["zoom"], p["flash"], p["split"]);
            let mut out = Vec::new();
            let g = |var: &str| format!("(pow(2,0-10*min({var}/{dur},1))-0.0009765625)/0.9990234375");
            if zoom > 0.0 {
                let z = format!("if({},1+{zoom}*({}),1)", gate(e, "time"), g("time"));
                out.push(zoom_frag(ctx, &z));
            }
            if flash > 0.0 {
                // eq adds equally to R,G,B (luma-only shift): b = 0.6·flash·(1-u/0.35)²
                let b = format!("{}*0.6*{flash}*pow(max(0,1-min(t/{dur},1)/0.35),2)", gate(e, "t"));
                out.push(format!("eq=brightness='{b}':eval=frame"));
            }
            if split > 0.0 && ctx.clip_ms > 0 {
                let name = attr_name(e, "hero");
                let w = ctx.w as f64;
                out.extend(rgb_split_cmds(e, ctx, &name, |t| {
                    let px = split / 100.0 * w * expo_decay(t / dur);
                    (round_half_up(px) as i32, 0)
                }));
            }
            (!out.is_empty()).then_some(out)
        }
        "beatImpact" => {
            let (zoom, flash, decay) = (p["zoom"], p["flash"], p["decay"]);
            let every = [1usize, 2, 4][p["every"] as usize];
            let beats = beat_times(e, every, p["offset"], ctx);
            if beats.is_empty() {
                return None;
            }
            let leaf = |var: &str, b: f64| format!("exp(0-{decay}*({var}-{b:.4}))");
            let mut out = Vec::new();
            if zoom > 0.0 {
                let z = format!("if({},1+{zoom}*{},1)", gate(e, "time"), beat_tree("time", &beats, &leaf));
                out.push(zoom_frag(ctx, &z));
            }
            if flash > 0.0 {
                let b = format!("{}*0.3*{flash}*{}", gate(e, "t"), beat_tree("t", &beats, &leaf));
                out.push(format!("eq=brightness='{b}':eval=frame"));
            }
            (!out.is_empty()).then_some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    fn fx(kind: &str, params: &[(&str, f64)], times: Option<Vec<f64>>) -> Effect {
        Effect {
            id: "abc12345-xyz".into(),
            kind: kind.into(),
            enabled: true,
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>(),
            in_ms: None,
            out_ms: None,
            file: None,
            times,
        }
    }

    fn ctx() -> FxCtx {
        FxCtx { w: 1920, h: 1080, fps_num: 30, fps_den: 1, clip_ms: 2000, source_in_ms: 0, speed: 1.0 }
    }

    #[test]
    fn curves_match_ts_golden() {
        let g: serde_json::Value =
            serde_json::from_str(include_str!("../../../shared/fx/curves.golden.json")).unwrap();
        let num = |k: &str| g[k].as_f64().unwrap_or_else(|| panic!("missing {k}"));
        let near = |a: f64, b: f64, k: &str| assert!((a - b).abs() < 1e-9, "{k}: rust {a} vs ts {b}");
        for t in [0.0, 0.05, 0.2, 0.37, 0.9, 1.4] {
            near(expo_decay(t), num(&format!("expo@{t}")), "expo");
            for m in 0..3u8 {
                near(rgb_env(m, 3.0, t), num(&format!("rgbEnv{m}@{t}")), "rgbEnv");
            }
            let sh = rgb_shift(1.2, 35.0, rgb_env(2, 3.0, t), 1920.0);
            let want = g[format!("shift@{t}")].as_array().unwrap();
            assert_eq!((sh.0 as f64, sh.1 as f64), (want[0].as_f64().unwrap(), want[1].as_f64().unwrap()), "shift@{t}");
            near(1.0 + 0.22 * expo_decay(t / 0.9), num(&format!("heroScale@{t}")), "heroScale");
            near(
                0.6 * 0.5 * (1.0f64 - (t / 0.9).min(1.0) / 0.35).max(0.0).powi(2),
                num(&format!("heroFlash@{t}")),
                "heroFlash",
            );
            near(
                round_half_up(1.0 / 100.0 * 1920.0 * expo_decay(t / 0.9)),
                num(&format!("heroSplit@{t}")),
                "heroSplit",
            );
        }
        // beats: trim/speed/offset mapping + decay env
        let e = fx("beatImpact", &[], Some(vec![1000.0, 1500.0, 2100.0, 3000.0]));
        let c = FxCtx { clip_ms: 10_000, source_in_ms: 500, speed: 1.0, ..FxCtx::default() };
        let beats = beat_times(&e, 1, 50.0, &c);
        let want: Vec<f64> = g["beats"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(beats.len(), want.len());
        for (a, b) in beats.iter().zip(&want) {
            near(*a, *b, "beat time");
        }
        for t in [0.0, 0.05, 0.2, 0.37, 0.9, 1.4] {
            let tt = t + 0.5;
            let env = beats.iter().rev().find(|b| **b <= tt).map_or(0.0, |b| (-8.0 * (tt - b)).exp());
            near(env, num(&format!("beatEnv@{t}")), "beatEnv");
        }
    }

    #[test]
    fn curves_have_exact_endpoints() {
        assert_eq!(expo_decay(0.0), 1.0);
        assert!(expo_decay(1.0).abs() < 1e-12);
        assert_eq!(rgb_env(0, 3.0, 0.7), 1.0);
        assert_eq!(rgb_env(1, 2.0, 0.0), 1.0); // pulse peaks at t=0
        assert!(rgb_env(2, 3.0, 0.4) >= 0.15 && rgb_env(2, 3.0, 0.4) <= 1.0);
        assert_eq!(rgb_shift(1.2, 0.0, 1.0, 1920.0), (23, 0));
        assert_eq!(rgb_shift(1.2, 90.0, 1.0, 1920.0).1, 23);
    }

    #[test]
    fn rgb_displacement_emits_changing_commands_only() {
        let f = fragments(&fx("rgbDisplacement", &[("mode", 0.0)], None), &ctx()).unwrap();
        // static mode → a single command at t=0
        assert_eq!(f[0].matches("rgbashift@").count(), 4, "{}", f[0]);
        assert!(f[0].starts_with("sendcmd=c='0.0000 rgbashift@rgdabc12345 rh 23"), "{}", f[0]);
        let g = fragments(&fx("rgbDisplacement", &[("mode", 2.0)], None), &ctx()).unwrap();
        assert!(g[0].matches(';').count() > 3, "glitch should change over time");
    }

    #[test]
    fn rgb_displacement_respects_window() {
        let mut e = fx("rgbDisplacement", &[("mode", 0.0)], None);
        e.in_ms = Some(500.0);
        e.out_ms = Some(1000.0);
        let f = fragments(&e, &ctx()).unwrap();
        // zero before the window, active inside, zero after
        assert!(f[0].contains("0.0000 rgbashift@rgdabc12345 rh 0"), "{}", f[0]);
        assert!(f[0].contains("0.5000 rgbashift@rgdabc12345 rh 23"), "{}", f[0]);
        assert!(f[0].contains("1.0000 rgbashift@rgdabc12345 rh 0"), "{}", f[0]);
    }

    #[test]
    fn beat_impact_uses_a_balanced_tree_and_skips_without_beats() {
        assert!(fragments(&fx("beatImpact", &[], None), &ctx()).is_none());
        let beats: Vec<f64> = (1..=200).map(|i| i as f64 * 500.0).collect();
        let mut c = ctx();
        c.clip_ms = 100_000;
        let f = fragments(&fx("beatImpact", &[], Some(beats)), &c).unwrap();
        assert!(f[0].contains("zoompan="));
        assert!(f[1].starts_with("eq=brightness="));
        // depth of nested `if(` stays ~log2(n), never n
        let max_depth = {
            let (mut d, mut m) = (0i32, 0i32);
            let s = &f[0];
            let mut i = 0;
            while i < s.len() {
                if s[i..].starts_with("if(") {
                    d += 1;
                    m = m.max(d);
                }
                if s.as_bytes()[i] == b')' {
                    d -= 1;
                }
                i += 1;
            }
            m
        };
        assert!(max_depth < 40, "if-nesting {max_depth}");
    }

    #[test]
    fn beat_times_follow_trim_speed_offset_and_every() {
        let e = fx("beatImpact", &[], Some(vec![1000.0, 1500.0, 2000.0, 2500.0, 3000.0]));
        let mut c = ctx();
        c.source_in_ms = 1000;
        c.speed = 2.0;
        c.clip_ms = 5000;
        // (src-1000)/2 + 100ms → 0.1, 0.35, 0.6, 0.85, 1.1
        let all = beat_times(&e, 1, 100.0, &c);
        assert_eq!(all.len(), 5);
        assert!((all[1] - 0.35).abs() < 1e-9);
        assert_eq!(beat_times(&e, 2, 100.0, &c).len(), 3);
    }

    #[test]
    fn unknown_kinds_and_bad_params_degrade() {
        assert!(fragments(&fx("nope", &[], None), &ctx()).is_none());
        // out-of-range params are clamped, not propagated
        let f = fragments(&fx("heroEntrance", &[("duration", 1.0), ("zoom", 99.0)], None), &ctx()).unwrap();
        assert!(f.iter().any(|x| x.contains("zoompan")));
        // zoom=99 clamps to the manifest max (0.6)
        assert!(f.iter().any(|x| x.contains("1+0.6*(")), "{f:?}");
        assert!(f.iter().all(|x| !x.contains("1+99")), "{f:?}");
    }
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn fx(kind: &str, params: &[(&str, f64)]) -> Effect {
        Effect {
            id: "f1l7er99".into(),
            kind: kind.into(),
            enabled: true,
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>(),
            in_ms: None,
            out_ms: None,
            file: None,
            times: None,
        }
    }

    #[test]
    fn teal_orange_chain_has_lut_and_spatial() {
        let out = fragments(&fx("tealOrange", &[]), &FxCtx::default()).unwrap();
        let joined = out.join("|");
        assert!(joined.contains("lut3d='"), "{joined}");
        assert!(joined.contains("interp=trilinear"));
        assert!(joined.contains("vignette=angle="));
        assert!(joined.contains("noise=alls="));
        assert!(joined.contains("rgbashift"));
        // .cube actually written to temp
        let lut = joined.split("lut3d='").nth(1).unwrap().split('\'').next().unwrap();
        let lut = lut.replace(r"\:", ":");
        assert!(std::path::Path::new(&lut).exists(), "{lut}");
    }

    #[test]
    fn intensity_scales_spatial_and_zero_is_noop() {
        let half = fragments(&fx("tealOrange", &[("intensity", 50.0)]), &FxCtx::default()).unwrap();
        assert!(half.join("|").contains("lut3d")); // LUT still present (baked at 50%)
        assert!(fragments(&fx("tealOrange", &[("intensity", 0.0)]), &FxCtx::default()).is_none());
    }

    #[test]
    fn window_wraps_each_fragment() {
        let mut e = fx("tealOrange", &[]);
        e.in_ms = Some(500.0);
        e.out_ms = Some(1500.0);
        // effect chain path (with_enable) must gate every fragment
        let chain = crate::render::effects::effects_chain_ctx(
            &[e],
            &FxCtx { w: 640, h: 360, fps_num: 30, fps_den: 1, clip_ms: 2000, source_in_ms: 0, speed: 1.0 },
        );
        assert!(chain.contains("enable='between(t,0.5,1.5)'"), "{chain}");
    }
}
