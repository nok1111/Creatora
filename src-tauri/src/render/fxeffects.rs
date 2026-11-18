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

// ── light & atmosphere curves (mirrored in envelopes.ts) ─────────────
//
// Overlay fields are BAKED once with `geq` (one frame, looped), then
// animated by cheap native filters: `crop` on a padded sprite translates
// it per frame, `rotate`/`overlay` sweep it, and a 1×1 `geq` envelope
// scaled to canvas + `blend=multiply` applies global flicker. Field
// functions are written once here (geq dialect) and once in
// gl-effects.ts (GLSL) — the shared curves below make the animated parts
// provably identical (curves.golden.json pins both).

/// Two-sine flicker in [1−2a, 1] — additive light breathing.
pub fn flicker_env(amt: f64, speed: f64, t: f64) -> f64 {
    let w = 0.65 * (6.2832 * speed * t).sin() + 0.35 * (6.2832 * speed * 2.63 * t + 1.3).sin();
    (1.0 - amt + amt * w).max(0.0)
}

/// geq/expression text of flicker_env over var `v` (frame seconds).
fn flicker_expr(amt: f64, speed: f64, v: &str) -> String {
    format!(
        "max(0,1-{a}+{a}*(0.65*sin(6.2832*{s}*{v})+0.35*sin(6.2832*{s}*2.63*{v}+1.3)))",
        a = fxlib::fmt_num(amt),
        s = fxlib::fmt_num(speed),
    )
}

/// Lens-flare drift around the anchor, frame fractions [dx·W, dy·H].
pub fn flare_drift(speed: f64, t: f64) -> (f64, f64) {
    (
        0.022 * (6.2832 * speed * t + 0.7).sin(),
        0.012 * (6.2832 * speed * 0.83 * t + 2.1).sin(),
    )
}

/// Light-leak drift, frame fractions (see envelopes.ts).
pub fn leak_drift(pattern: i64, travel: f64, speed: f64, t: f64) -> (f64, f64) {
    let s = 0.5 + 0.5 * (6.2832 * speed * t - 1.5708).sin();
    match pattern {
        1 => (-0.5 * travel * s, 0.7 * travel * s),
        2 => (0.6 * travel * s, 0.0),
        _ => (travel * s, 0.0),
    }
}

/// God-rays sway (radians) about the baked fan orientation.
pub fn rays_sway_rad(deg: f64, speed: f64, t: f64) -> f64 {
    deg.to_radians() * (6.2832 * speed * t).sin()
}

/// Prism glint sweep — x offset in frame fractions, −0.35 → 1.35 loop.
pub fn glint_sweep(speed: f64, t: f64) -> f64 {
    if speed <= 0.0 {
        return 0.0;
    }
    let u = speed * t - (speed * t).floor();
    -0.35 + 1.7 * u
}

// ── light & atmosphere fragment builders ─────────────────────────────

/// geq field helpers — all fields are in H-fraction units:
/// dx = (X − ax·W)/H, dy = (Y − ay·H)/H — identical to the GLSL in
/// gl-effects.ts, which uses (uv − c)·(aspect, 1).
mod geq {
    use super::fxlib::fmt_num as n;

    /// (dx, dy) in H-fraction units for a padded sprite: anchors are baked
    /// at (m + a·canvas_dim) px inside a (W+2m)×(H+2m) canvas.
    pub fn d(m: u32, ax: f64, ay: f64, w: u32, h: u32) -> (String, String) {
        (
            format!("(X-{})/{h}", n(m as f64 + ax * w as f64)),
            format!("(Y-{})/{h}", n(m as f64 + ay * h as f64)),
        )
    }

    /// Channel colour: tint mixed toward white by `hot`, scaled by `lum`
    /// (field luminance exprs, unclamped) → 0..255.
    pub fn chan(lum: &str, tint: f64, hot: &str) -> String {
        format!("255*min(1,({}+(1-{})*{})*({}))", n(tint), n(tint), hot, lum)
    }
}

/// Baked sprite (pad margin `m` px each side) → loop → per-frame crop
/// translate → 1×1 flicker envelope → multiply → screen-blend onto the
/// incoming stream. `geq_rgb` = r/g/b field exprs in sprite px.
fn screen_overlay_frag(
    e: &Effect,
    ctx: &FxCtx,
    i: f64,
    en: &str,
    geq_rgb: &(String, String, String),
    m: u32,
    crop_x: &str,
    crop_y: &str,
    env_amt: f64,
    env_speed: f64,
) -> Vec<String> {
    let (w, h) = (ctx.w, ctx.h);
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    let (b, s, sv, ev, ov, mm) = (
        attr_name(e, "la"),
        attr_name(e, "lb"),
        attr_name(e, "lc"),
        attr_name(e, "ld"),
        attr_name(e, "le"),
        attr_name(e, "lm"),
    );
    // Intensity folds into the envelope: multiply gives s·i·env, then a
    // full-opacity screen = the preview's screen(c, l·i·env) exactly.
    // (blend:all_opacity would crossfade AFTER screening — different.)
    let env = format!("255*{}*{}", fxlib::fmt_num(i), flicker_expr(env_amt, env_speed, "T"));
    vec![
        format!("null[{mm}]"),
        format!(
            "color=c=black:s={}x{}:r=1:d=1,format=rgb24,geq=r='{}':g='{}':b='{}'[{b}]",
            w + 2 * m,
            h + 2 * m,
            geq_rgb.0,
            geq_rgb.1,
            geq_rgb.2
        ),
        format!("[{b}]loop=loop=-1:size=1,fps={fps}[{s}]"),
        format!("[{s}]crop=w={w}:h={h}:x='{m}+({crop_x})':y='{m}+({crop_y})'[{sv}]"),
        format!("color=c=black:s=1x1:r={fps}:d={dur},format=rgb24,geq=r='{env}':g='{env}':b='{env}',scale={w}:{h}[{ev}]"),
        format!("[{sv}][{ev}]blend=all_mode=multiply[{ov}]"),
        format!("[{mm}][{ov}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

/// Cinematic Lens Flare — baked anamorphic streak + core + ghosts.
fn lens_flare_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (w, h) = (ctx.w as f64, ctx.h as f64);
    let m = (0.06 * w).ceil() as u32; // margin ≥ |drift| (0.022W, 0.012H)
    let (ax, ay) = (p["x"] / 100.0, p["y"] / 100.0);
    let (dx, dy) = geq::d(m, ax, ay, ctx.w, ctx.h);
    let asp = w / h;
    let (sx, sy, cr) = (0.26 * p["spread"] * asp, 0.004, 0.045);
    let field = |extra_ghosts: &str| {
        format!(
            "1.6*exp(-pow({dy}/{sy},2)-pow({dx}/{sx},2))+1.4*exp(-({dx}*{dx}+{dy}*{dy})/{cr2})+0.5*exp(-({dx}*{dx}+{dy}*{dy})/0.18){extra_ghosts}",
            sy = fxlib::fmt_num(sy),
            sx = fxlib::fmt_num(sx),
            cr2 = fxlib::fmt_num(2.0 * cr * cr),
        )
    };
    // ghost amps by `ghosts` const (0/2/4) — same table as gl-effects.ts
    let amps = [[0.0; 4], [0.5, 0.6, 0.0, 0.0], [0.5, 0.6, 0.45, 0.35]][
        (p["ghosts"].round() as usize / 2).min(2)
    ];
    let pos = [(-0.55, 0.07), (0.38, 0.045), (0.62, 0.03), (-0.30, 0.11)];
    let ghosts = pos
        .iter()
        .zip(&amps)
        .filter(|(_, a)| **a > 0.0)
        .map(|((gx, gr), a)| {
            format!(
                "+{}*exp(-pow((hypot({dx}-({gx}),{dy}))/{gr},2))",
                fxlib::fmt_num(*a),
                gx = fxlib::fmt_num(*gx),
                gr = fxlib::fmt_num(*gr)
            )
        })
        .collect::<String>();
    let lum = field(&ghosts);
    let hot = format!("min(1,0.7*exp(-({dx}*{dx}+{dy}*{dy})/{cr2}))", cr2 = fxlib::fmt_num(2.0 * cr * cr));
    let geq_rgb = (
        geq::chan(&lum, p["cr"], &hot),
        geq::chan(&lum, p["cg"], &hot),
        geq::chan(&lum, p["cb"], &hot),
    );
    // crop x increases → content shifts LEFT; drift must be negated.
    let cx = format!("0-{}*sin(6.2832*{}*t+0.7)", fxlib::fmt_num(0.022 * w), fxlib::fmt_num(p["speed"]));
    let cy = format!("0-{}*sin(6.2832*{}*t+2.1)", fxlib::fmt_num(0.012 * h), fxlib::fmt_num(p["speed"] * 0.83));
    screen_overlay_frag(e, ctx, i, en, &geq_rgb, m, &cx, &cy, p["flicker"], 0.7 + 5.0 * p["speed"])
}

/// Light Leak — baked organic blob field, drifting in from an edge.
fn light_leak_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (w, h) = (ctx.w as f64, ctx.h as f64);
    let pat = p["pattern"].round() as i64;
    let (ax, ay) = match pat {
        1 => (1.02, -0.04),
        2 => (-0.06, 0.5),
        _ => (-0.04, 0.45),
    };
    let m = (0.2 * w).ceil() as u32; // ≥ leak travel 0.16W
    let (dx, dy) = geq::d(m, ax, ay, ctx.w, ctx.h);
    let s = p["spread"] * 0.55;
    let s2 = fxlib::fmt_num(2.0 * s * s);
    // organic secondary lobe (offset 0.55σ, −0.35σ in H-units) + optional
    // second anchor (dual sides)
    let lobe = format!("({dx}-{})", fxlib::fmt_num(0.55 * s));
    let lobe_y = format!("({dy}+{})", fxlib::fmt_num(0.35 * s));
    let aux = format!("0.5*exp(-({lobe}*{lobe}+{ly}*{ly})/{s4})", ly = lobe_y, s4 = fxlib::fmt_num(2.0 * s * s * 0.25));
    let dual = if pat == 2 {
        let (d2x, d2y) = geq::d(m, 1.12, 0.5, ctx.w, ctx.h);
        format!("+exp(-({d2x}*{d2x}+{d2y}*{d2y})/{s2})")
    } else {
        String::new()
    };
    let lum = format!("2.2*(exp(-({dx}*{dx}+{dy}*{dy})/{s2})+{aux}{dual})");
    let dual_hot = if pat == 2 {
        let (ddx, ddy) = geq::d(m, 1.12, 0.5, ctx.w, ctx.h);
        format!("+0.5*exp(-({ddx}*{ddx}+{ddy}*{ddy})/{s2})")
    } else {
        String::new()
    };
    let hot = format!(
        "min(1,1.2*exp(-({dx}*{dx}+{dy}*{dy})/{sc}){dual_hot})",
        sc = fxlib::fmt_num(2.0 * s * s * 0.12),
    );
    let col = p["color"].round() as u32;
    let (cr, cg, cb) = (
        ((col >> 16) & 255) as f64 / 255.0,
        ((col >> 8) & 255) as f64 / 255.0,
        (col & 255) as f64 / 255.0,
    );
    let geq_rgb = (
        geq::chan(&lum, cr, &hot),
        geq::chan(&lum, cg, &hot),
        geq::chan(&lum, cb, &hot),
    );
    // drift, negated (crop-window semantics) and converted to px
    let (nx, ny) = {
        let s_expr = format!("(0.5+0.5*sin(6.2832*{}*t-1.5708))", fxlib::fmt_num(p["speed"]));
        match pat {
            1 => (
                format!("{}*{}", fxlib::fmt_num(0.5 * 0.11 * w), s_expr),
                format!("0-{}*{}", fxlib::fmt_num(0.7 * 0.11 * h), s_expr),
            ),
            2 => (
                format!("0-{}*{}", fxlib::fmt_num(0.6 * 0.11 * w), s_expr),
                "0".into(),
            ),
            _ => (
                format!("0-{}*{}", fxlib::fmt_num(0.11 * w), s_expr),
                "0".into(),
            ),
        }
    };
    screen_overlay_frag(e, ctx, i, en, &geq_rgb, m, &nx, &ny, p["flicker"], 0.4 + 3.0 * p["speed"])
}

/// God Rays — per-frame quarter-res geq fan (sway+breathe inside T).
fn god_rays_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (w, h) = (ctx.w, ctx.h);
    let (gw, gh) = ((w / 4).max(16), (h / 4).max(16));
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    let (px, py) = (p["x"] / 100.0 * gw as f64, p["y"] / 100.0 * gh as f64);
    let dx = format!("(X-{})/{gh}", fxlib::fmt_num(px), gh = gh);
    let dy = format!("(Y-{})/{gh}", fxlib::fmt_num(py), gh = gh);
    // fan angle + sway (same constants as preview pack: ±7° sway)
    let ang = format!(
        "atan2({dy},{dx})-({a0}+{sw}*sin(6.2832*{sp}*T))",
        a0 = fxlib::fmt_num(p["angle"].to_radians()),
        sw = fxlib::fmt_num(7f64.to_radians()),
        sp = fxlib::fmt_num(p["speed"]),
    );
    let comb = format!(
        "pow(max(0,0.5+0.5*sin({n}*({ang}))),{pe})",
        n = fxlib::fmt_num(p["density"]),
        pe = fxlib::fmt_num(2.0 + 10.0 * (1.0 - p["spread"]))
    );
    let rad = format!("exp(-sqrt({dx}*{dx}+{dy}*{dy})/{r0})", r0 = fxlib::fmt_num(p["length"] * 0.9));
    let env = flicker_expr(0.25, 0.5 + 3.0 * p["speed"], "T");
    let lum = format!("({comb})*({rad})*({env})*{g}", g = fxlib::fmt_num(i * 1.9));
    let expr = |c: f64| format!("255*min(1,{}*{})", fxlib::fmt_num(c), lum);
    let (mm, gv, ov) = (attr_name(e, "gm"), attr_name(e, "gs"), attr_name(e, "go"));
    vec![
        format!("null[{mm}]"),
        format!(
            "color=c=black:s={gw}x{gh}:r={fps}:d={dur},format=rgb24,geq=r='{}':g='{}':b='{}'[{gv}]",
            expr(1.0),
            expr(0.93),
            expr(0.75),
        ),
        format!("[{gv}]scale={w}:{h}[{ov}]"),
        format!("[{mm}][{ov}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

/// Prism Refraction — plane-split dispersion + baked spectral glint.
fn prism_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (w, h) = (ctx.w, ctx.h);
    let (fw, fh) = (w as f64, h as f64);
    let fps = ctx.fps_str();
    let (cx, cy) = (p["x"] / 100.0 * fw, p["y"] / 100.0 * fh);
    let k = p["amount"] * 0.008;
    let pat = p["pattern"].round() as i64;
    let (mm, wk) = (attr_name(e, "pm"), attr_name(e, "pw"));
    let mut v = vec![format!("split[{mm}][{wk}]")];
    let mut d_out;
    if pat == 1 {
        // Edge Split — uniform diagonal dispersion (mirrors preview's
        // vec2(k*1.6, k*0.7) H-unit offset → px)
        let dxs = (k * 1.6 * fh).round() as i32;
        let dys = (k * 0.7 * fh).round() as i32;
        d_out = attr_name(e, "pd");
        v.push(format!("[{wk}]rgbashift=rh={dxs}:rv={dys}:bh={}:bv={}[{d_out}]", -dxs, -dys));
    } else {
        // Radial/Halo — scale the real channel planes about the pivot:
        // crop offset (f−1)·P (see design: S(q)=R(q/f + P(1−1/f))).
        let b0 = 1.06;
        let (fr, fg, fb) = (b0 * (1.0 + k), b0, b0 * (1.0 - k));
        let (pr, pg, pb) = (attr_name(e, "pr"), attr_name(e, "pg"), attr_name(e, "pb"));
        let (rs, gs, bs) = (attr_name(e, "ps"), attr_name(e, "pt"), attr_name(e, "pu"));
        let (rc, gc, bc) = (attr_name(e, "px"), attr_name(e, "py"), attr_name(e, "pz"));
        d_out = attr_name(e, "pd");
        v.extend([
            format!("[{wk}]format=gbrp,split=3[{pr}][{pg}][{pb}]"),
            format!("[{pr}]scale=w='iw*{}':h='ih*{}'[{rs}]", fxlib::fmt_num(fr), fxlib::fmt_num(fr)),
            format!("[{pg}]scale=w='iw*{}':h='ih*{}'[{gs}]", fxlib::fmt_num(fg), fxlib::fmt_num(fg)),
            format!("[{pb}]scale=w='iw*{}':h='ih*{}'[{bs}]", fxlib::fmt_num(fb), fxlib::fmt_num(fb)),
            format!("[{rs}]crop=w={w}:h={h}:x={}:y={},setsar=1[{rc}]", fxlib::fmt_num((fr - 1.0) * cx), fxlib::fmt_num((fr - 1.0) * cy)),
            format!("[{gs}]crop=w={w}:h={h}:x={}:y={},setsar=1[{gc}]", fxlib::fmt_num((fg - 1.0) * cx), fxlib::fmt_num((fg - 1.0) * cy)),
            format!("[{bs}]crop=w={w}:h={h}:x={}:y={},setsar=1[{bc}]", fxlib::fmt_num((fb - 1.0) * cx), fxlib::fmt_num((fb - 1.0) * cy)),
            // gbrp planes: G,B,R — inputs ordered [g][b][r]
            format!("[{gc}][{bc}][{rc}]mergeplanes=format=gbrp:map0s=0:map0p=0:map1s=1:map1p=1:map2s=2:map2p=2[{d_out}]"),
        ]);
    }
    // spectral glint — baked sprite composited inside the effect branch
    let amp = p["glint"];
    if amp > 0.0 {
        let (gb, gl, go, dg) = (attr_name(e, "ga"), attr_name(e, "gb"), attr_name(e, "gc"), attr_name(e, "pf"));
        if pat == 2 {
            // Halo — static spectral ring around the pivot
            let dx = format!("(X-{})/{fh}", fxlib::fmt_num(cx));
            let dy = format!("(Y-{})/{fh}", fxlib::fmt_num(cy));
            let rr = format!("sqrt({dx}*{dx}+{dy}*{dy})");
            let ring = format!("exp(-pow({rr}-0.3,2)/0.005)");
            let spec = |ph: f64| format!("255*min(1,{}*({ring})*(0.5+0.5*cos(atan2({dy},{dx})+{ph})))", fxlib::fmt_num(amp), ph = fxlib::fmt_num(ph));
            v.extend([
                format!("color=c=black:s={w}x{h}:r=1:d=1,format=rgb24,geq=r='{}':g='{}':b='{}'[{gb}]", spec(0.0), spec(2.09), spec(4.19)),
                format!("[{gb}]loop=loop=-1:size=1,fps={fps}[{gl}]"),
                format!("[{d_out}][{gl}]blend=all_mode=screen[{dg}]"),
            ]);
        } else {
            // Radial/Edge — diagonal band sweeping the frame. Sprite is
            // padded by G=0.9W so the band can travel fully off-frame.
            let g = (0.9 * fw).ceil() as u32;
            let dgx = format!("(X-{})/{fh}", fxlib::fmt_num(g as f64 + 0.5 * fw));
            let dgy = format!("(Y-{})/{fh}", fxlib::fmt_num(0.5 * fh));
            // band normal/direction for angle −0.55 rad
            // n = (−bd.y, bd.x) = (0.5227, 0.8525), bd = (0.8525, −0.5227)
            let q = format!("{dgx}*0.5227+{dgy}*0.8525");
            let coord = format!("{dgx}*0.8525-{dgy}*0.5227");
            let band = format!("exp(-({q})*({q})/0.0162)");
            let spec = |ph: f64| {
                format!("255*min(1,{}*({band})*(0.5+0.5*cos(6.2832*(({coord})*1.4+{ph}))))", fxlib::fmt_num(amp), ph = fxlib::fmt_num(ph))
            };
            let sweep = format!("mod({}*t,1)", fxlib::fmt_num(p["speed"]));
            v.extend([
                format!("color=c=black:s={}x{h}:r=1:d=1,format=rgb24,geq=r='{}':g='{}':b='{}'[{gb}]", w + 2 * g, spec(0.0), spec(0.33), spec(0.67)),
                format!("[{gb}]loop=loop=-1:size=1,fps={fps}[{gl}]"),
                format!("[{gl}]crop=w={w}:h={h}:x='{g}+{}-{}*({sweep})':y=0[{go}]", fxlib::fmt_num(0.85 * fw), fxlib::fmt_num(1.7 * fw)),
                format!("[{d_out}][{go}]blend=all_mode=screen[{dg}]"),
            ]);
        }
        d_out = dg;
    }
    v.push(format!("[{mm}][{d_out}]blend=all_mode=normal:all_opacity={}{en}", fxlib::fmt_num(i)));
    v
}

// ── batch 2: dust / glint / trails / golden ───────────────────────────

/// Balanced-tree sum: `a+b+c+…` nests linearly in ffmpeg's recursive
/// expression parser and blows its stack (silent ENOMEM / empty output)
/// past ~30 terms. Pairwise reduction keeps depth at log2(n).
fn sum_tree(mut ts: Vec<String>) -> String {
    if ts.is_empty() {
        return "0".into();
    }
    while ts.len() > 1 {
        let mut next = Vec::with_capacity(ts.len() / 2 + 1);
        for c in ts.chunks(2) {
            next.push(if c.len() == 2 {
                format!("({}+{})", c[0], c[1])
            } else {
                c[0].clone()
            });
        }
        ts = next;
    }
    ts.pop().unwrap()
}

/// `fract(sin(cx*a + cy*b)*43758.5453)` — same sin-hash polynomial the
/// GLSL `dh/sh` helpers use, so preview and export lay particles out
/// identically.
fn ghash(cx: &str, cy: &str, a: f64, b: f64) -> String {
    let v = format!("sin(({cx})*{}+({cy})*{})*43758.5453", fxlib::fmt_num(a), fxlib::fmt_num(b));
    format!("({v}-floor({v}))")
}

/// Floating Dust — cell-hash particle field, live quarter-res geq.
/// Each cell owns ≤1 particle on a slow elliptical orbit; a 3×3 stencil
/// catches orbit crossings. No wrap discontinuities (all sin orbits).
fn floating_dust_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh_ as f64;
    let (u, v) = (format!("X/{ghf}"), format!("Y/{ghf}"));
    let cs = 0.075;
    let density = p["density"];
    let size = p["size"];
    let twk = p["twinkle"];
    let spd = p["speed"];
    let mut terms = Vec::new();
    for ix in -1..=1 {
        for iy in -1..=1 {
            let cx = format!("floor({u}/{cs}){}{}", if ix >= 0 { "+" } else { "" }, ix);
            let cy = format!("floor({v}/{cs}){}{}", if iy >= 0 { "+" } else { "" }, iy);
            let h1 = ghash(&cx, &cy, 127.1, 311.7);
            let h2 = ghash(&cx, &cy, 269.5, 183.3);
            let h3 = ghash(&cx, &cy, 419.2, 371.9);
            let h4 = ghash(&cx, &cy, 113.5, 271.9);
            let h5 = ghash(&cx, &cy, 213.9, 117.3);
            let tt = format!("(T*{})", fxlib::fmt_num(spd));
            let orb_x = format!("0.13*sin(6.2832*({tt}*(0.055+0.10*{h2})+{h3}))");
            let orb_y = format!("0.09*sin(6.2832*({tt}*(0.045+0.08*{h4})+{h5}))");
            let px = format!("({cx}+0.15+0.7*{h3}+{orb_x})*{cs}");
            let py = format!("({cy}+0.15+0.7*{h5}+{orb_y})*{cs}");
            let r2 = format!("(({u}-({px}))*({u}-({px}))+({v}-({py}))*({v}-({py})))");
            // bimodal depth: ~20% near floaters (big/soft), rest are small
            // bright motes that read as dust catching light, not bokeh
            let near = format!("gte({h4},0.8)");
            let sr = format!("((0.008+0.014*{near}*(0.35+0.65*{h3}))*{sz})", sz = fxlib::fmt_num(size));
            let tw = format!(
                "(1-{tk}*0.6*(0.5+0.5*sin(6.2832*{tt}*(0.09+0.2*{h3})+{h4}*6.2832)))",
                tk = fxlib::fmt_num(twk)
            );
            let patch = ghash(&format!("floor(({cx})/3)"), &format!("floor(({cy})/3)"), 53.7, 141.3);
            let bri = format!(
                "(((0.65+0.55*{h2})*(1-{near})+0.5*{near})*{tw}*(0.5+0.5*{patch}))"
            );
            let sr2 = format!("({sr}*{sr})");
            terms.push(format!(
                "lt({h1},{d})*({bri})*(exp(-{r2}/(2*{sr2}))+{near}*0.5*exp(-{r2}/(10*{sr2})))",
                d = fxlib::fmt_num(density)
            ));
        }
    }
    let field = sum_tree(terms);
    // Dust only lives where the scene is lit: the geq runs ON the
    // quarter-res input and dims the field by local luma (GLSL twin
    // smoothsteps src() identically).
    let luma = "(0.299*r(X,Y)+0.587*g(X,Y)+0.114*b(X,Y))/255";
    let lt = format!("clip(({luma}-0.12)/0.58,0,1)");
    let lumw = format!("(0.3+0.7*{lt}*{lt}*(3-2*{lt}))");
    let (mm, mq, gs, go) = (attr_name(e, "dm"), attr_name(e, "dq"), attr_name(e, "ds"), attr_name(e, "do"));
    let expr = |c: f64| format!("255*min(1,{}*({field})*{lumw}*{})", fxlib::fmt_num(c), fxlib::fmt_num(i * 1.35));
    vec![
        format!("split[{mm}][{mq}]"),
        format!(
            "[{mq}]scale={gw}:{gh_},format=rgb24,geq=r='{}':g='{}':b='{}'[{gs}]",
            expr(p["cr"]),
            expr(p["cg"]),
            expr(p["cb"]),
        ),
        format!("[{gs}]scale={w}:{h},gblur=sigma=1.5[{go}]", w = ctx.w, h = ctx.h),
        format!("[{mm}][{go}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

/// Star Glint — sparkle bound to the frame's own luminance. The geq runs
/// ON the quarter-res main input and samples its channels at cell
/// centres (r/g/b input sampling): a star only ignites where the image
/// is already bright. Preview samples the source texture identically.
fn star_glint_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh_ as f64;
    let (u, v) = (format!("X/{ghf}"), format!("Y/{ghf}"));
    let cs = 0.115;
    let th = p["threshold"];
    let lobes = p["rays"] / 2.0;
    let size = p["size"];
    let spd = p["speed"];
    let rainbow = p["colMode"] > 0.5;
    let samp = |cxp: &str, cyp: &str| {
        // max luma over a 5-tap cross (GLSL twin taps src() the same way)
        let l = |dx: &str, dy: &str| {
            format!(
                "(0.299*r(({cxp}){dx},{cyp}{dy})+0.587*g(({cxp}){dx},({cyp}){dy})+0.114*b(({cxp}){dx},({cyp}){dy}))/255"
            )
        };
        let o = format!("0.28*{cs}*{ghf}"); // px units (cxp is already *ghf)
        format!(
            "max(max({c},{p1}),max(max({p2},{p3}),{p4}))",
            c = l("", ""),
            p1 = l(&format!("+{o}"), ""),
            p2 = l(&format!("-{o}"), ""),
            p3 = l("", &format!("+{o}")),
            p4 = l("", &format!("-{o}")),
        )
    };
    let mut terms_r = Vec::new();
    let mut terms_g = Vec::new();
    let mut terms_b = Vec::new();
    for ix in -1..=1 {
        for iy in -1..=1 {
            let cx = format!("floor({u}/{cs}){}{}", if ix >= 0 { "+" } else { "" }, ix);
            let cy = format!("floor({v}/{cs}){}{}", if iy >= 0 { "+" } else { "" }, iy);
            let ccx = format!("({cx}+0.5)*{cs}");
            let ccy = format!("({cy}+0.5)*{cs}");
            let l = samp(&format!("({ccx})*{ghf}"), &format!("({ccy})*{ghf}"));
            let m = format!("min(1,max(0,({l}-{th})/{den}))", th = fxlib::fmt_num(th), den = fxlib::fmt_num((1.0 - th).max(0.05)));
            let h1 = ghash(&cx, &cy, 127.1, 311.7);
            let h2 = ghash(&cx, &cy, 269.5, 183.3);
            let gate = ghash(&cx, &cy, 419.2, 371.9); // thin the field out
            let rot = format!("({h1}-0.5)*0.9");
            let lx = format!("({u}-({ccx}))");
            let ly = format!("({v}-({ccy}))");
            let r = format!("sqrt({lx}*{lx}+{ly}*{ly})");
            let a = format!("(atan2({ly},{lx})+{rot})");
            let arms = format!("pow(abs(cos({n}*{a})),64)", n = fxlib::fmt_num(lobes));
            let tw = format!("(0.4+0.6*(0.5+0.5*sin(6.2832*{sp}*T+{h2}*6.2832)))", sp = fxlib::fmt_num(spd));
            let sig = fxlib::fmt_num(0.012 * size);
            let rayl = fxlib::fmt_num(0.07 * size);
            let star = format!(
                "gte({gate},0.38)*({m})*({tw})*(1.3*exp(-{r}*{r}/(2*{sig}*{sig}))+0.9*({arms})*exp(-{r}/{rayl}))"
            );
            if rainbow {
                for (out, ph) in [(&mut terms_r, 0.0), (&mut terms_g, 2.09), (&mut terms_b, 4.19)] {
                    out.push(format!(
                        "{star}*(0.55+0.45*cos(6.2832*{r}*2.6+{a}+{ph}))",
                        ph = fxlib::fmt_num(ph)
                    ));
                }
            } else {
                terms_r.push(star.clone());
                terms_g.push(star.clone());
                terms_b.push(star);
            }
        }
    }
    let tint = |c: f64, body: &str| format!("255*min(1,{}*({body})*{gain})", fxlib::fmt_num(c), gain = fxlib::fmt_num(i * 2.2));
    let (mm, mq, gf, go) = (attr_name(e, "gm"), attr_name(e, "gq"), attr_name(e, "gf"), attr_name(e, "go"));
    vec![
        format!("split[{mm}][{mq}]"),
        format!("[{mq}]scale={gw}:{gh_},format=rgb24,geq=r='{}':g='{}':b='{}'[{gf}]",
            tint(p["cr"], &sum_tree(terms_r)),
            tint(p["cg"], &sum_tree(terms_g)),
            tint(p["cb"], &sum_tree(terms_b))),
        format!("[{gf}]scale={w}:{h},gblur=sigma=2[{go}]", w = ctx.w, h = ctx.h),
        format!("[{mm}][{go}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

/// Neon Trails — a STATIC comet field baked once at quarter res (no T:
/// init-eval only, expr cost irrelevant), then animated by rotating the
/// sprite around the frame centre. Each closed Lissajous loop carries a
/// bright head arc fading into a tail, so rotation reads as light
/// racing along organic paths. Preview rotates its sampling coords
/// over the identical static field — same model both sides.
fn neon_trails_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh_ as f64;
    let asp = ctx.w as f64 / ctx.h as f64;
    let (u, v) = (format!("X/{ghf}"), format!("Y/{ghf}"));
    let m_nodes = 26usize;
    let sig = 0.008 * p["thickness"];
    let sig2 = fxlib::fmt_num(2.0 * sig * sig);
    let sig14 = fxlib::fmt_num(14.0 * sig * sig);
    let k_trails = (p["trails"].round() as usize).clamp(1, 4);
    let glow = p["glow"];
    let rainbow = p["colMode"] > 0.5;
    let mut terms_r = Vec::new();
    let mut terms_g = Vec::new();
    let mut terms_b = Vec::new();
    for i in 0..k_trails {
        let fi = i as f64;
        let ax = (0.50 + 0.26 * (fi * 2.13 + 0.7).sin()) * asp;
        let bx = (0.30 + 0.14 * (fi * 1.37 + 0.2).sin()) * asp;
        let kx = 1.0 + fi % 2.0;
        let ay = 0.50 + 0.24 * (fi * 1.71 + 2.1).sin();
        let by = 0.24 + 0.12 * (fi * 2.41 + 0.5).cos();
        let ky = 1.0 + (fi + 1.0) % 3.0;
        let off = fi * 0.331;
        for j in 0..m_nodes {
            let sj = (j as f64 + 0.5) / m_nodes as f64 + off;
            let s1 = sj + 1.0 / m_nodes as f64;
            let path = |s: f64| {
                (
                    ax + bx * (std::f64::consts::TAU * (kx * s + fi * 0.37)).sin(),
                    ay + by * (std::f64::consts::TAU * (ky * s + fi * 0.61)).sin(),
                )
            };
            let (ax0v, ay0v) = path(sj);
            let (bx0v, by0v) = path(s1);
            // point→segment distance in H-units, constants pre-baked
            let (ax0, ay0) = (fxlib::fmt_num(ax0v), fxlib::fmt_num(ay0v));
            let bax = fxlib::fmt_num(bx0v - ax0v);
            let bay = fxlib::fmt_num(by0v - ay0v);
            let len2 = fxlib::fmt_num((bx0v - ax0v).powi(2) + (by0v - ay0v).powi(2));
            let tj = format!(
                "min(1,max(0,(({u}-({ax0}))*{bax}+({v}-({ay0}))*{bay})/max({len2},0.0000001)))"
            );
            let r2 = format!(
                "(({u}-({ax0})-{bax}*({tj}))*({u}-({ax0})-{bax}*({tj}))+({v}-({ay0})-{bay}*({tj}))*({v}-({ay0})-{bay}*({tj})))"
            );
            // comet weight: bright head at s≈1 fading backward along the loop
            let frac = sj - sj.floor();
            let wj = (-(1.0 - frac) * 5.5).exp() + 0.06;
            let node = format!(
                "{wj}*(exp(-{r2}/{sig2})+{gl}*exp(-{r2}/{sig14}))",
                wj = fxlib::fmt_num(wj),
                gl = fxlib::fmt_num(glow * 0.5)
            );
            if rainbow {
                for (out, phc) in [(&mut terms_r, 0.0), (&mut terms_g, 2.09), (&mut terms_b, 4.19)] {
                    out.push(format!("{node}*({col})", col = fxlib::fmt_num(
                        0.55 + 0.45 * (std::f64::consts::TAU * frac * 1.4 + phc).cos()
                    )));
                }
            } else {
                terms_r.push(node.clone());
                terms_g.push(node.clone());
                terms_b.push(node);
            }
        }
    }
    let tint = |c: f64, body: &str| format!("255*min(1,{}*({body})*{gain})", fxlib::fmt_num(c), gain = fxlib::fmt_num(i * 1.4));
    let (mm, nb, nr, ev, ns, no) = (
        attr_name(e, "nm"), attr_name(e, "nb"), attr_name(e, "nr"),
        attr_name(e, "ne"), attr_name(e, "ns"), attr_name(e, "no"),
    );
    let dur = ctx.clip_ms as f64 / 1000.0;
    vec![
        format!("null[{mm}]"),
        // one static bake (geq init-eval only — the huge field costs once)
        format!(
            "color=c=black:s={gw}x{gh_}:r=1:d=1,format=rgb24,geq=r='{}':g='{}':b='{}',loop=loop=-1:size=1,fps={fps}[{nb}]",
            tint(p["cr"], &sum_tree(terms_r)),
            tint(p["cg"], &sum_tree(terms_g)),
            tint(p["cb"], &sum_tree(terms_b)),
            fps = ctx.fps_str(),
        ),
        // rotate the baked field: head arc travels around the loops
        format!(
            "[{nb}]rotate=a='({ang}+{wob}*sin(6.2832*0.11*t))':c=black:ow={gw}:oh={gh_}[{nr}]",
            ang = format!("6.2832*{}*t", fxlib::fmt_num(p["speed"])),
            wob = fxlib::fmt_num(3f64.to_radians()),
        ),
        // subtle energy pulse via 1x1 env multiply
        format!(
            "color=c=black:s=1x1:r={fps}:d={dur},geq=r='255*(0.8+0.2*sin(6.2832*0.9*T))':g='255*(0.8+0.2*sin(6.2832*0.9*T))':b='255*(0.8+0.2*sin(6.2832*0.9*T))'[{ev}]",
            fps = ctx.fps_str(),
        ),
        format!("[{ev}]scale={gw}:{gh_}[{ev}]"),
        format!("[{nr}][{ev}]blend=all_mode=multiply[{ns}]"),
        format!("[{ns}]scale={w}:{h},gblur=sigma=2[{no}]", w = ctx.w, h = ctx.h),
        format!("[{mm}][{no}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

/// Golden Rays — godRays machinery with warm gold tint, softer comb and
/// an ambient halo around the source. Live quarter-res geq.
fn golden_rays_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh as f64;
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    let (px, py) = (p["x"] / 100.0 * gw as f64, p["y"] / 100.0 * gh as f64);
    let dx = format!("(X-{})/{gh}", fxlib::fmt_num(px), gh = ghf);
    let dy = format!("(Y-{})/{gh}", fxlib::fmt_num(py), gh = ghf);
    let ang = format!(
        "atan2({dy},{dx})-({a0}+{sw}*sin(6.2832*{sp}*T))",
        a0 = fxlib::fmt_num(p["angle"].to_radians()),
        sw = fxlib::fmt_num(5f64.to_radians()),
        sp = fxlib::fmt_num(p["speed"]),
    );
    let comb = format!(
        "pow(max(0,0.5+0.5*sin({n}*({ang}))),{pe})",
        n = fxlib::fmt_num(p["density"]),
        pe = fxlib::fmt_num(3.0 + 14.0 * (1.0 - p["spread"]))
    );
    let rad = format!("exp(-sqrt({dx}*{dx}+{dy}*{dy})/{r0})", r0 = fxlib::fmt_num(p["length"] * 0.65));
    let halo = format!("{}*exp(-({dx}*{dx}+{dy}*{dy})/0.16)", fxlib::fmt_num(p["halo"] * 0.9));
    let env = flicker_expr(0.18, 0.4 + 3.0 * p["speed"], "T");
    let lum = format!("((({comb})*({rad}))+({halo}))*({env})*{g}", g = fxlib::fmt_num(i * 1.5));
    let expr = |c: f64| format!("255*min(1,{}*{})", fxlib::fmt_num(c), lum);
    let (mm, gv, ov) = (attr_name(e, "am"), attr_name(e, "as"), attr_name(e, "ao"));
    vec![
        format!("null[{mm}]"),
        format!(
            "color=c=black:s={gw}x{gh}:r={fps}:d={dur},format=rgb24,geq=r='{}':g='{}':b='{}'[{gv}]",
            expr(1.0),
            expr(0.8),
            expr(0.45),
        ),
        format!("[{gv}]scale={w}:{h}[{ov}]", w = ctx.w, h = ctx.h),
        format!("[{mm}][{ov}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

// ── batch 3: embers / fog / fireflies / snow ─────────────────────────

/// smoothstep(a,b,x) in geq dialect: clip + hermite (x*x*(3-2x)).
fn ssq(a: f64, b: f64, x: &str) -> String {
    let t = format!("clip(({x}-{})/{},0,1)", fxlib::fmt_num(a), fxlib::fmt_num(b - a));
    format!("({t}*{t}*(3-2*{t}))")
}

/// Bilinear value noise at lattice coords (px,py) — same sin-hash the
/// GLSL `vn` uses, so the fog field matches preview.
fn vnoise(px: &str, py: &str) -> String {
    let ix = format!("floor({px})");
    let iy = format!("floor({py})");
    let fxx = format!("({px}-{ix})");
    let fyy = format!("({py}-{iy})");
    let ux = format!("({fxx}*{fxx}*(3-2*{fxx}))");
    let uy = format!("({fyy}*{fyy}*(3-2*{fyy}))");
    let a = ghash(&ix, &iy, 127.1, 311.7);
    let b = ghash(&format!("({ix}+1)"), &iy, 127.1, 311.7);
    let c = ghash(&ix, &format!("({iy}+1)"), 127.1, 311.7);
    let d = ghash(&format!("({ix}+1)"), &format!("({iy}+1)"), 127.1, 311.7);
    format!("(({a}+({b}-{a})*{ux})*(1-{uy})+({c}+({d}-{c})*{ux})*{uy})")
}

/// Per-frame weight envelope (0.5∓0.5·cos) baked as a 1×1 geq and
/// scaled to the scroll-window size — the seamless-scroll crossfade.
fn scroll_env(tag: &str, gw: u32, gh: u32, rate_px: f64, period_px: f64, plus: bool, fps: &str, dur: f64) -> Vec<String> {
    let sgn = if plus { "+" } else { "-" };
    let w = format!(
        "255*(0.5{sgn}0.5*cos(6.2832*mod({rp}*T,{pp})/{pp}))",
        rp = fxlib::fmt_num(rate_px),
        pp = fxlib::fmt_num(period_px)
    );
    vec![
        format!(
            "color=c=black:s=1x1:r={fps}:d={dur},format=rgb24,geq=r='{w}':g='{w}':b='{w}'[{tag}1]"
        ),
        format!("[{tag}1]scale={gw}:{gh}[{tag}]"),
    ]
}

/// Floating Embers — bake+scroll (neonTrails machinery): a tall static
/// ember strip is baked ONCE, a window scrolls it upward; two copies
/// offset half a period crossfade at weight-0 wraps → infinite seamless
/// rise. Per-ember lifecycle baked in via a low-freq noise multiplier
/// (embers dim/brighten along their path); gust wobble via crop x.
/// Live per-pixel geq of this complexity measured ~60 s/frame — this
/// model is ~2 crops + 2 multiplies + 1 add per frame.
fn floating_embers_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh_ as f64;
    let (u, v) = (format!("X/{ghf}"), format!("Y/{ghf}"));
    let (csx, csy) = (0.055f64, 0.34f64);
    let density = p["density"];
    let size = p["size"];
    let flk = p["flicker"];
    let sway = p["sway"];
    let rv = 4.0 * csy;                                   // scroll period (v-units)
    let rpx = (rv * ghf).round().max(1.0);                // scroll period (px)
    let rate_v = 0.06 + 0.14 * p["speed"];                // rise, v-units/s
    let rpy = rate_v * ghf;                               // px/s
    let mx_v = sway * 0.06;                               // gust margin (v-units)
    let mx = (mx_v * ghf).ceil() as u32 + 1;
    let gw_t = gw + 2 * mx;
    let gh_t = gh_ + rpx as u32;
    let htf = gh_t as f64 / ghf;                          // strip height, v-units
    // static ember field (no T) over the strip
    let mut terms = Vec::new();
    for ix in -1..=1 {
        for iy in -1..=1 {
            let cx = format!("floor({u}/{csx}){}{ix}", if ix >= 0 { "+" } else { "" });
            let cy = format!("floor({v}/{csy}){}{iy}", if iy >= 0 { "+" } else { "" });
            let h1 = ghash(&cx, &cy, 127.1, 311.7);
            let h2 = ghash(&cx, &cy, 269.5, 183.3);
            let h3 = ghash(&cx, &cy, 419.2, 371.9);
            let h4 = ghash(&cx, &cy, 113.5, 271.9);
            let h5 = ghash(&cx, &cy, 213.9, 117.3);
            let px = format!("(({cx}+0.15+0.7*{h3})*{csx})");
            let yw = format!("(({cy}+{h5})*{csy})");
            let ddx = format!("({u}-({px}))");
            let ddy = format!("({v}-({yw}))");
            // embers fade near strip edges (window reaches both ends)
            let eedge = format!(
                "clip(min({yw},({ht}-{yw}))/0.08,0,1)",
                ht = fxlib::fmt_num(htf)
            );
            let bri = format!("({edge}*(0.45+0.75*{h2}))", edge = eedge);
            let sx = format!("((0.0035+0.006*{h4})*{sz})", sz = fxlib::fmt_num(size));
            let trl = format!("(1+gte({h3},0.72)*(0.5+1.5*{h5}))");
            let vy = format!("(0.04+0.10*{h2})");
            let sy = format!("({sx}*{trl}*(1+6*{vy}))");
            let rc = format!("(0.45*{sx})");
            let r2 = format!("({ddx}*{ddx}+{ddy}*{ddy})");
            let g = format!("exp(-{ddx}*{ddx}/(2*{sx}*{sx})-{ddy}*{ddy}/(2*{sy}*{sy}))+0.4*exp(-{r2}/(2*{rc}*{rc}))");
            terms.push(format!(
                "if(lt({h1},{d}),({bri})*{g},0)",
                d = fxlib::fmt_num(density)
            ));
        }
    }
    // lifecycle baked in: low-freq noise multiplier (flicker param)
    let nz = vnoise(&format!("({u}*6)"), &format!("({v}*4)"));
    let mult = format!(
        "(1-{fk}+{fk}*(0.35+0.95*{nz}))",
        fk = fxlib::fmt_num(flk)
    );
    let field = format!("({})*{mult}", sum_tree(terms));
    let expr = |c: f64| format!("255*min(1,{}*({field})*{})", fxlib::fmt_num(c), fxlib::fmt_num(i * 1.25));
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    let n = |t: &str| attr_name(e, t);
    let (mm, eb, sa, sb, ea, eb2, wa, wb, aw, bw, sm, go) = (
        n("em"), n("eb"), n("es"), n("et"), n("ea"), n("e2"), n("ew"),
        n("ev"), n("ek"), n("el"), n("en"), n("eo"),
    );
    let gust = format!("{mx}+{amp}*sin(6.2832*0.07*t)", amp = fxlib::fmt_num(mx_v * ghf));
    let mut out = vec![
        format!("null[{mm}]"),
        format!(
            "color=c=black:s={gw_t}x{gh_t}:r=1:d=1,format=rgb24,geq=r='{}':g='{}':b='{}',loop=loop=-1:size=1,fps={fps}[{eb}]",
            expr(p["cr"]),
            expr(p["cg"]),
            expr(p["cb"]),
        ),
        format!("[{eb}]split[{sa}][{sb}]"),
        format!(
            "[{sa}]crop=w={gw}:h={gh_}:x='{gust}':y='mod({rpy}*t,{rpx})'[{ea}]",
            rpy = fxlib::fmt_num(rpy), rpx = fxlib::fmt_num(rpx)
        ),
        format!(
            "[{sb}]crop=w={gw}:h={gh_}:x='{gust}':y='mod({rpy}*t+{rh},{rpx})'[{eb2}]",
            rpy = fxlib::fmt_num(rpy), rh = fxlib::fmt_num(rpx / 2.0), rpx = fxlib::fmt_num(rpx)
        ),
    ];
    out.extend(scroll_env(&wa, gw, gh_, rpy, rpx, false, &fps, dur));
    out.extend(scroll_env(&wb, gw, gh_, rpy, rpx, true, &fps, dur));
    out.extend(vec![
        format!("[{ea}][{wa}]blend=all_mode=multiply[{aw}]"),
        format!("[{eb2}][{wb}]blend=all_mode=multiply[{bw}]"),
        format!("[{aw}][{bw}]blend=all_mode=addition[{sm}]"),
        format!("[{sm}]scale={w}:{h},gblur=sigma=1.5[{go}]", w = ctx.w, h = ctx.h),
        format!("[{mm}][{go}]blend=all_mode=screen:all_opacity=1{en}"),
    ]);
    out
}

/// Cinematic Fog — bake+scroll: each FBM layer is baked once as a wide
/// strip, a window drifts across it horizontally; two copies offset
/// half a lattice period crossfade at weight-0 wraps → infinite drift.
/// Coverage/power/pooling applied per-frame in a SMALL geq (~cheap);
/// luma gating via a gray+curves mask of the input (fog lives in light).
fn cinematic_fog_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 8).max(16), (ctx.h / 8).max(16));
    let ghf = gh_ as f64;
    let (sc, ani, plw, mix2, drv) = match p["pattern"].round() as i64 {
        1 => (2.2, 1.4, 0.55, 0.45, 2.1),   // Rolling Fog
        2 => (1.9, 1.0, 0.15, 0.35, 0.7),   // Cinematic Haze
        _ => (2.6, 2.4, 1.00, 0.30, 1.0),   // Ground Fog
    };
    let asp = ctx.w as f64 / ctx.h as f64;
    let lwf = asp * sc / ani;                             // lattice width across frame
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    // one scrolling layer: bake wide strip + 2 crops + env crossfade + add
    let mut out = vec![format!("split[{m}][{q}]", m = attr_name(e, "fm"), q = attr_name(e, "fq"))];
    let mut layer_labels = Vec::new();
    // each layer: own lattice space (mult 1 / 1.7), own drift rate, own gain
    for (li, (mult, lrate, lgain)) in [
        (1.0f64, 0.55 * p["speed"] * drv, 1.0 - mix2),
        (1.7,     1.30 * p["speed"] * drv, mix2),
    ]
    .iter()
    .enumerate()
    {
        let ll = lwf * mult;                               // lattice width across frame
        let rx = (gw as f64 / ll).ceil().max(2.0);         // scroll period px (1 lattice unit)
        let rate_px = lrate * rx;                          // px/s window advance
        let gw_t = gw + rx as u32;
        // strip lattice coords: qx spans [0, LL+1] over gw+rx px
        let qx = format!("X*{l}", l = fxlib::fmt_num(ll / gw as f64));
        let qy = format!("Y*{l}", l = fxlib::fmt_num(sc * mult / ghf));
        // same fbm both layers (GLSL: fbm(p) / fbm(p*1.7))
        let fbm = format!(
            "({}+0.5*{})",
            vnoise(&qx, &qy),
            vnoise(&format!("({qx}*2.3+17.3)"), &format!("({qy}*2.3+17.3)"))
        );
        // fbm/1.5 normalised, layer gain folded into the bake
        let gv = fxlib::fmt_num(lgain * 255.0 / 1.5);
        let fb = attr_name(e, &format!("f{li}b"));
        let (sa, sb, ca, cb, wa, wb, aw, bw, sm) = (
            attr_name(e, &format!("f{li}s")),
            attr_name(e, &format!("f{li}t")),
            attr_name(e, &format!("f{li}a")),
            attr_name(e, &format!("f{li}c")),
            attr_name(e, &format!("f{li}w")),
            attr_name(e, &format!("f{li}v")),
            attr_name(e, &format!("f{li}k")),
            attr_name(e, &format!("f{li}l")),
            attr_name(e, &format!("f{li}n")),
        );
        out.push(format!(
            "color=c=black:s={gw_t}x{gh_}:r=1:d=1,format=rgb24,geq=r='{gv}*{fbm}':g='{gv}*{fbm}':b='{gv}*{fbm}',loop=loop=-1:size=1,fps={fps}[{fb}]"
        ));
        out.push(format!("[{fb}]split[{sa}][{sb}]"));
        // layer 2 drifts opposite to layer 1 (GLSL: -fract(d2))
        let (xa, xb) = if li == 0 {
            (
                format!("mod({rp}*t,{rx})", rp = fxlib::fmt_num(rate_px), rx = fxlib::fmt_num(rx)),
                format!("mod({rp}*t+{rh},{rx})", rp = fxlib::fmt_num(rate_px), rh = fxlib::fmt_num(rx / 2.0), rx = fxlib::fmt_num(rx)),
            )
        } else {
            (
                format!("{rx}-mod({rp}*t,{rx})", rp = fxlib::fmt_num(rate_px), rx = fxlib::fmt_num(rx)),
                format!("{rx}-mod({rp}*t+{rh},{rx})", rp = fxlib::fmt_num(rate_px), rh = fxlib::fmt_num(rx / 2.0), rx = fxlib::fmt_num(rx)),
            )
        };
        out.push(format!("[{sa}]crop=w={gw}:h={gh_}:x='{xa}':y=0[{ca}]"));
        out.push(format!("[{sb}]crop=w={gw}:h={gh_}:x='{xb}':y=0[{cb}]"));
        out.extend(scroll_env(&wa, gw, gh_, rate_px, rx, false, &fps, dur));
        out.extend(scroll_env(&wb, gw, gh_, rate_px, rx, true, &fps, dur));
        out.push(format!("[{ca}][{wa}]blend=all_mode=multiply[{aw}]"));
        out.push(format!("[{cb}][{wb}]blend=all_mode=multiply[{bw}]"));
        out.push(format!("[{aw}][{bw}]blend=all_mode=addition[{sm}]"));
        layer_labels.push(sm);
    }
    // combine layers, then coverage/pow/pool in a small per-frame geq
    let fs = attr_name(e, "fs");
    let fsh = attr_name(e, "fh");
    let fmk = attr_name(e, "fk");
    let fm2 = attr_name(e, "f2");
    let fo = attr_name(e, "fo");
    let fq = attr_name(e, "fq");
    let mm = attr_name(e, "fm");
    out.push(format!("[{l0}][{l1}]blend=all_mode=addition[{fs}]", l0 = layer_labels[0], l1 = layer_labels[1]));
    let flv = "(r(X,Y)/255)";
    let cov = format!(
        "clip(({flv}-{c0})/{c1},0,1)",
        c0 = fxlib::fmt_num((1.0 - p["coverage"]) * 0.75),
        c1 = fxlib::fmt_num((p["coverage"] * 0.38).max(0.05))
    );
    let v_ = format!("Y/{ghf}");
    let shaped = format!(
        "pow({cov},{kk})*(1-{pl}+{pl}*{pool})*{ig}",
        kk = fxlib::fmt_num(1.0 + 1.0 * p["thickness"]),
        pl = fxlib::fmt_num(plw * p["pool"]),
        ig = fxlib::fmt_num(i * 1.8),
        pool = ssq(-0.15, 1.05, &v_)
    );
    out.push(format!(
        "[{fs}]geq=r='255*min(1,{cr}*{sh})':g='255*min(1,{cg}*{sh})':b='255*min(1,{cb_}*{sh})'[{fsh}]",
        cr = fxlib::fmt_num(p["cr"]),
        cg = fxlib::fmt_num(p["cg"]),
        cb_ = fxlib::fmt_num(p["cb"]),
        sh = shaped
    ));
    // luma mask: fog lives where the scene is lit (0.25+0.75·ss(0.1,0.7))
    let luma = "(0.299*r(X,Y)+0.587*g(X,Y)+0.114*b(X,Y))/255";
    let lumw = format!("255*(0.25+0.75*{})", ssq(0.1, 0.7, luma));
    out.push(format!("[{fq}]scale={gw}:{gh_},format=rgb24,geq=r='{lumw}':g='{lumw}':b='{lumw}'[{fmk}]"));
    out.push(format!("[{fsh}][{fmk}]blend=all_mode=multiply[{fm2}]"));
    out.push(format!("[{fm2}]scale={w}:{h},gblur=sigma=4[{fo}]", w = ctx.w, h = ctx.h));
    out.push(format!("[{mm}][{fo}]blend=all_mode=screen:all_opacity=1{en}"));
    let _ = i;
    out
}

/// Fireflies — N unrolled wanderers (NOT cell-bound): each rides a
/// sum of incommensurate sines per axis (turns + pauses fall out),
/// flashing with a soft-attack blink. Small core, wide halo. The
/// geq bakes `count` particles per-export; the GLSL loops 16 and
/// gates by the same uniform.
fn fireflies_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh_ as f64;
    let asp = ctx.w as f64 / ctx.h as f64;
    let (u, v) = (format!("X/{ghf}"), format!("Y/{ghf}"));
    let fr = |x: f64| x - x.floor(); // GLSL fract (always ≥0)
    let hsh = |i: f64, k: f64| fr((i * 127.1 + k * 311.7).sin() * 43758.5453);
    let count = (p["count"].round() as usize).clamp(1, 16);
    let tt = format!("(T*{})", fxlib::fmt_num(p["speed"]));
    let tb = format!("(T*{})", fxlib::fmt_num(0.25 + 1.1 * p["blink"]));
    let sig = 0.006 * p["size"];
    let mut terms = Vec::new();
    for i in 0..count {
        let fi = i as f64;
        let (h1, h2, h3, h4) = (hsh(fi, 1.0), hsh(fi, 2.0), hsh(fi, 3.0), hsh(fi, 4.0));
        let wx = format!(
            "({ax}+{a1}*sin(6.2832*({tt}*{f1}+{p1}))+{a2}*sin(6.2832*({tt}*{f2}+{p2}))+{a3}*sin(6.2832*({tt}*{f3}+{p3})))",
            ax = fxlib::fmt_num(0.5 * asp),
            a1 = fxlib::fmt_num(0.28 + 0.20 * h1), f1 = fxlib::fmt_num(0.021 + 0.035 * h1), p1 = fxlib::fmt_num(h2),
            a2 = fxlib::fmt_num(0.12),             f2 = fxlib::fmt_num(0.075 + 0.06 * h3),  p2 = fxlib::fmt_num(h4),
            a3 = fxlib::fmt_num(0.04),             f3 = fxlib::fmt_num(0.21 + 0.12 * h2),   p3 = fxlib::fmt_num(h1),
        );
        let wy = format!(
            "(0.55+{a1}*sin(6.2832*({tt}*{f1}+{p1}))+{a2}*sin(6.2832*({tt}*{f2}+{p2}))+{a3}*sin(6.2832*({tt}*{f3}+{p3})))",
            a1 = fxlib::fmt_num(0.22 + 0.18 * h3), f1 = fxlib::fmt_num(0.017 + 0.03 * h2), p1 = fxlib::fmt_num(h1),
            a2 = fxlib::fmt_num(0.10),             f2 = fxlib::fmt_num(0.06 + 0.05 * h4),  p2 = fxlib::fmt_num(h3),
            a3 = fxlib::fmt_num(0.035),            f3 = fxlib::fmt_num(0.18 + 0.10 * h1),  p3 = fxlib::fmt_num(h2),
        );
        let ddx = format!("({u}-({wx}))");
        let ddy = format!("({v}-({wy}))");
        let r2 = format!("({ddx}*{ddx}+{ddy}*{ddy})");
        let bl = format!("(0.5+0.5*sin(6.2832*({tb}*{fq}+{ph})))",
            fq = fxlib::fmt_num(0.35 + 0.4 * h4), ph = fxlib::fmt_num(h2));
        let gate = ssq(0.35, 0.8, &bl);
        let bri = format!("((0.18+0.82*{gate})*{})", fxlib::fmt_num(0.6 + 0.5 * h1));
        let s2 = fxlib::fmt_num(2.0 * sig * sig);
        let sh = fxlib::fmt_num(2.0 * sig * sig * (14.0 + 30.0 * p["glow"]));
        terms.push(format!("({bri})*(1.6*exp(-{r2}/{s2})+0.7*exp(-{r2}/{sh}))"));
    }
    let field = sum_tree(terms);
    let expr = |c: f64| format!("255*min(1,{}*({field})*{})", fxlib::fmt_num(c), fxlib::fmt_num(i * 1.5));
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    let (mm, gs, go) = (attr_name(e, "fm"), attr_name(e, "fs"), attr_name(e, "fo"));
    vec![
        format!("null[{mm}]"),
        format!(
            "color=c=black:s={gw}x{gh_}:r={fps}:d={dur},format=rgb24,geq=r='{}':g='{}':b='{}'[{gs}]",
            expr(p["cr"]),
            expr(p["cg"]),
            expr(p["cb"]),
        ),
        format!("[{gs}]scale={w}:{h},gblur=sigma=1.5[{go}]", w = ctx.w, h = ctx.h),
        format!("[{mm}][{go}]blend=all_mode=screen:all_opacity=1{en}"),
    ]
}

/// Falling Snow — bake+scroll, two independent strips (far/near).
/// Each layer's flake field is static in strip space; its window
/// scrolls DOWN (flakes fall) at layer speed → real parallax. Double
/// copies crossfade at weight-0 wraps. Gust sway via crop x.
fn falling_snow_frag(e: &Effect, ctx: &FxCtx, i: f64, en: &str, p: &std::collections::BTreeMap<String, f64>) -> Vec<String> {
    let (gw, gh_) = ((ctx.w / 4).max(16), (ctx.h / 4).max(16));
    let ghf = gh_ as f64;
    let (u, v) = (format!("X/{ghf}"), format!("Y/{ghf}"));
    let dur = ctx.clip_ms as f64 / 1000.0;
    let fps = ctx.fps_str();
    let mm = attr_name(e, "sm");
    let mut out = vec![format!("null[{mm}]")];
    let mut layer_labels = Vec::new();
    for lay in 0..2 {
        let is_n = lay == 1;
        let (csx, csy) = if is_n { (0.13f64, 0.52f64) } else { (0.05, 0.30) };
        let wgt = if is_n { 0.45 + 0.55 * p["depth"] } else { 0.72 - 0.30 * p["depth"] };
        let dens = if is_n { p["density"] * 0.55 } else { p["density"] };
        let rv = 4.0 * csy;                                   // scroll period (v-units)
        let rpx = (rv * ghf).round().max(1.0);
        let rate_v = (0.05 + 0.09 * p["speed"]) * if is_n { 1.35 } else { 0.7 };
        let rpy = rate_v * ghf;                               // px/s
        let (gust_f, gust_ph) = if is_n { (0.08f64, 1.9f64) } else { (0.05, 0.0) };
        let mx_v = p["sway"] * 0.04;
        let mx = (mx_v * ghf).ceil() as u32 + 1;
        let gw_t = gw + 2 * mx;
        let gh_t = gh_ + rpx as u32;
        let htf = gh_t as f64 / ghf;
        // static flake field over the strip (same math as GLSL laySnow)
        let mut terms = Vec::new();
        for ix in -1..=1 {
            for iy in -1..=1 {
                let cx = format!("floor({u}/{csx}){}{ix}", if ix >= 0 { "+" } else { "" });
                let cy = format!("floor({v}/{csy}){}{iy}", if iy >= 0 { "+" } else { "" });
                let off = lay as f64 * 37.7;
                let cxo = format!("({cx}+{off})");
                let h1 = ghash(&cxo, &cy, 127.1, 311.7);
                let h2 = ghash(&cxo, &cy, 269.5, 183.3);
                let h3 = ghash(&cxo, &cy, 419.2, 371.9);
                let h4 = ghash(&cxo, &cy, 113.5, 271.9);
                let h5 = ghash(&cxo, &cy, 213.9, 117.3);
                let px = format!("(({cx}+0.1+0.8*{h3})*{csx})");
                let yw = format!("(({cy}+{h5})*{csy})");
                let ddx = format!("({u}-({px}))");
                let ddy = format!("({v}-({yw}))");
                let r2 = format!("({ddx}*{ddx}+{ddy}*{ddy})");
                let sr = format!(
                    "(({s0}+{s1}*{h4})*{sz})",
                    s0 = fxlib::fmt_num(if is_n { 0.008 } else { 0.0026 }),
                    s1 = fxlib::fmt_num(if is_n { 0.010 } else { 0.0022 }),
                    sz = fxlib::fmt_num(p["size"])
                );
                let eedge = format!(
                    "clip(min({yw},({ht}-{yw}))/0.08,0,1)",
                    ht = fxlib::fmt_num(htf)
                );
                let bri = format!("({edge}*{wg}*(0.55+0.45*{h2}))", edge = eedge, wg = fxlib::fmt_num(wgt));
                terms.push(format!(
                    "if(lt({h1},{d}),({bri})*exp(-{r2}/(2*{sr}*{sr})),0)",
                    d = fxlib::fmt_num(dens)
                ));
            }
        }
        let field = sum_tree(terms);
        let fb = attr_name(e, &format!("s{lay}b"));
        let (sa, sb, ca, cb, wa, wb, aw, bw, sm) = (
            attr_name(e, &format!("s{lay}s")),
            attr_name(e, &format!("s{lay}t")),
            attr_name(e, &format!("s{lay}a")),
            attr_name(e, &format!("s{lay}c")),
            attr_name(e, &format!("s{lay}w")),
            attr_name(e, &format!("s{lay}v")),
            attr_name(e, &format!("s{lay}k")),
            attr_name(e, &format!("s{lay}l")),
            attr_name(e, &format!("s{lay}n")),
        );
        let expr = |c: f64| format!("255*min(1,{}*({field})*{})", fxlib::fmt_num(c), fxlib::fmt_num(i * 1.3));
        out.push(format!(
            "color=c=black:s={gw_t}x{gh_t}:r=1:d=1,format=rgb24,geq=r='{}':g='{}':b='{}',loop=loop=-1:size=1,fps={fps}[{fb}]",
            expr(p["cr"]),
            expr(p["cg"]),
            expr(p["cb"]),
        ));
        out.push(format!("[{fb}]split[{sa}][{sb}]"));
        // falling: window slides UP the strip (content moves down)
        let gust = format!(
            "{mx}+{amp}*sin(6.2832*{gf}*t+{gp})",
            amp = fxlib::fmt_num(mx_v * ghf),
            gf = fxlib::fmt_num(gust_f),
            gp = fxlib::fmt_num(gust_ph)
        );
        out.push(format!(
            "[{sa}]crop=w={gw}:h={gh_}:x='{gust}':y='{rpx}-mod({rpy}*t,{rpx})'[{ca}]",
            rpx = fxlib::fmt_num(rpx),
            rpy = fxlib::fmt_num(rpy)
        ));
        out.push(format!(
            "[{sb}]crop=w={gw}:h={gh_}:x='{gust}':y='{rpx}-mod({rpy}*t+{rh},{rpx})'[{cb}]",
            rpx = fxlib::fmt_num(rpx),
            rpy = fxlib::fmt_num(rpy),
            rh = fxlib::fmt_num(rpx / 2.0)
        ));
        out.extend(scroll_env(&wa, gw, gh_, rpy, rpx, false, &fps, dur));
        out.extend(scroll_env(&wb, gw, gh_, rpy, rpx, true, &fps, dur));
        out.push(format!("[{ca}][{wa}]blend=all_mode=multiply[{aw}]"));
        out.push(format!("[{cb}][{wb}]blend=all_mode=multiply[{bw}]"));
        out.push(format!("[{aw}][{bw}]blend=all_mode=addition[{sm}]"));
        layer_labels.push(sm);
    }
    let ss2 = attr_name(e, "ss");
    let go = attr_name(e, "so");
    out.push(format!("[{l0}][{l1}]blend=all_mode=addition[{ss2}]", l0 = layer_labels[0], l1 = layer_labels[1]));
    out.push(format!("[{ss2}]scale={w}:{h},gblur=sigma=1.5[{go}]", w = ctx.w, h = ctx.h));
    out.push(format!("[{mm}][{go}]blend=all_mode=screen:all_opacity=1{en}"));
    out
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

/// Single-clip field effects (intro/outro): the declarative ax/ay/m/glow
/// recipe animates across the effect window as reduced-res geq field
/// videos — the same dialect the transition fields engine and the GLSL
/// preview share. The clip is remapped by (ax,ay), merged to black by
/// `m` (1 = clip shown), and the tinted `glow` field screen-blends on
/// top. `u` clamps to the window so outside it the recipe is identity —
/// no enable gating needed (remap/maskedmerge don't take `enable`).
fn effect_fields_frag(
    e: &Effect,
    ctx: &FxCtx,
    entry: &fxlib::FxEntry,
    div: u32,
    fields: &std::collections::BTreeMap<String, String>,
) -> Option<String> {
    let (w, h) = (ctx.w as f64, ctx.h as f64);
    let dur_s = ctx.clip_ms as f64 / 1000.0;
    let (w0, w1) = window_s(e);
    let w1 = w1.min(dur_s);
    if w1 <= w0 || dur_s <= 0.0 {
        return None;
    }
    let win = w1 - w0;
    let fps = format!("{}/{}", ctx.fps_num, ctx.fps_den);
    // Window progress for field frame N (field videos run at project fps).
    let u = format!(
        "clip((((N+0.5)*{fd}/{fn_})-{w0})/{win},0,1)",
        fd = ctx.fps_den,
        fn_ = ctx.fps_num,
        w0 = fxlib::fmt_num(w0),
        win = fxlib::fmt_num(win)
    );
    let div = (h / 135.0).round().clamp(1.0, div.max(1) as f64);
    let (lw, lh) = (((w / div).ceil() as u32).max(2), ((h / div).ceil() as u32).max(2));
    let cx = format!("((X+0.5)*{}-0.5)", fxlib::fmt_num(div));
    let cy = format!("((Y+0.5)*{}-0.5)", fxlib::fmt_num(div));
    let mapped = |name: &str| -> Option<String> {
        let raw = fields.get(name)?;
        let t = fxlib::expand_text(entry, raw, &e.params, entry.default_ease.as_deref(), &u).ok()?;
        let t = fxlib::ident_replace(&t, "X", "§X");
        let t = fxlib::ident_replace(&t, "Y", "§Y");
        let t = fxlib::ident_replace(&t, "W", &fxlib::fmt_num(w));
        let t = fxlib::ident_replace(&t, "H", &fxlib::fmt_num(h));
        Some(t.replace("§X", &cx).replace("§Y", &cy))
    };
    let field = |fmt: &str, gq: &str| {
        format!(
            "color=c=black:s={lw}x{lh}:r={fps}:d={d:.4},format={fmt},geq=lum='{gq}',scale={w}:{h}:flags=bilinear",
            w = ctx.w,
            h = ctx.h,
            d = dur_s + 0.2
        )
    };
    let (ax, ay, m) = (mapped("ax")?, mapped("ay")?, mapped("m")?);
    let (fsp, fbk, fax, fay, fmm, fwp, fmg, fgl) = (
        attr_name(e, "fs"), attr_name(e, "fb"), attr_name(e, "fx"), attr_name(e, "fy"),
        attr_name(e, "fm"), attr_name(e, "fw"), attr_name(e, "fg"), attr_name(e, "fl"),
    );
    let mut s = String::new();
    // Field recipes live in canvas pixels but the clip stream only fits
    // inside the canvas (scale=decrease + optional crop/zoom). Normalise
    // it to full canvas first so fields, mask, black and remap all agree
    // — remap output takes the map size, so every input must be WxH.
    s.push_str(&format!(
        "scale=w={w}:h={h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,split[{fsp}][{fbk}];",
        w = ctx.w, h = ctx.h
    ));
    s.push_str(&format!(
        "[{fbk}]colorchannelmixer=rr=0:rg=0:rb=0:gr=0:gg=0:gb=0:br=0:bg=0:bb=0,format=gbrap[{fbk}];"
    ));
    s.push_str(&format!("{}[{fax}];", field("gray16le", &format!("clip({ax},0,{})", w - 1.0))));
    s.push_str(&format!("{}[{fay}];", field("gray16le", &format!("clip({ay},0,{})", h - 1.0))));
    // maskedmerge(first=warped, second=black, mask=1-m): m=1 → clip shown.
    s.push_str(&format!("{}[{fmm}];", field("gray", &format!("255*clip(1-({m}),0,1)"))));
    s.push_str(&format!("[{fsp}]format=gbrap[{fsp}];"));
    s.push_str(&format!("[{fsp}][{fax}][{fay}]remap[{fwp}];"));
    s.push_str(&format!("[{fwp}][{fbk}][{fmm}]maskedmerge[{fmg}]"));
    if let Some(glow) = mapped("glow") {
        let c = fxlib::resolve_constants(entry, &e.params);
        let tint = |k: &str| fxlib::fmt_num(c.get(k).copied().unwrap_or(255.0).clamp(0.0, 255.0));
        s.push_str(&format!(
            ";color=c=black:s={lw}x{lh}:r={fps}:d={d:.4},format=gbrp,geq=r='min(({g})*{tr},255)':g='min(({g})*{tg},255)':b='min(({g})*{tb},255)',scale={w}:{h}:flags=bilinear[{fgl}]",
            g = glow,
            tr = tint("cr"),
            tg = tint("cg"),
            tb = tint("cb"),
            w = ctx.w,
            h = ctx.h,
            d = dur_s + 0.2
        ));
        s.push_str(&format!(";[{fmg}][{fgl}]blend=all_mode='screen',format=rgba"));
    } else {
        s.push_str(&format!(";[{fmg}]format=rgba"));
    }
    Some(s)
}

/// Focus Pull — rack-focus entrance: heavy optical defocus collapsing to
/// sharp, a gentle exposure settle and a slight breathing zoom. Blur is
/// a down/up scale pair (per-frame `eval=frame`) plus a light gblur to
/// kill blockiness; all envelopes run on window progress like the field
/// effects, so outside the window every term is identity.
fn focus_pull_frag(e: &Effect, ctx: &FxCtx, p: &std::collections::BTreeMap<String, f64>) -> Option<Vec<String>> {
    let dur_s = ctx.clip_ms as f64 / 1000.0;
    let (w0, w1) = window_s(e);
    let w1 = w1.min(dur_s);
    if w1 <= w0 {
        return None;
    }
    let (def, set, br) = (p["defocus"], p["settle"], p["breathe"]);
    // wt = window progress 0→1; blur/settle/zoom all decay as (1-wt)^k.
    // scale/eq expose `t`; zoompan only knows `time` — two spellings.
    let wt_t = format!("clip((t-{})/{},0,1)", fxlib::fmt_num(w0), fxlib::fmt_num(w1 - w0));
    let wt_z = format!("clip((time-{})/{},0,1)", fxlib::fmt_num(w0), fxlib::fmt_num(w1 - w0));
    let mut out = Vec::new();
    if def > 0.0 {
        let sf = format!("(1-{}*pow(1-{wt_t},3))", fxlib::fmt_num(def * 0.94));
        out.push(format!(
            "scale=w='max(8,iw*{sf})':h='max(8,ih*{sf})':eval=frame,scale={}:{}:flags=bicubic,gblur=sigma=1.4",
            ctx.w, ctx.h
        ));
    }
    if set > 0.0 {
        let b = format!("{}*pow(1-{wt_t},2)", fxlib::fmt_num(set * 0.35));
        out.push(format!("eq=brightness='{b}':eval=frame"));
    }
    if br > 0.0 {
        let z = format!("1+{}*pow(1-{wt_z},2)", fxlib::fmt_num(br * 0.06));
        out.push(zoom_frag(ctx, &z));
    }
    (!out.is_empty()).then_some(out)
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
    // Light & Atmosphere: baked geq sprites + native animation, all
    // screen-blended (prism uses a bypass crossfade instead). Windowing
    // lands on the trailing blend — disabled → first input passes.
    if matches!(
        e.kind.as_str(),
        "lensFlare" | "lightLeak" | "godRays" | "prismRefraction"
            | "floatingDust" | "starGlint" | "neonTrails" | "goldenRays"
            | "floatingEmbers" | "cinematicFog" | "fireflies" | "fallingSnow"
    ) {
        let i = (p.get("intensity").copied().unwrap_or(100.0) / 100.0).clamp(0.0, 1.0);
        if i <= 0.0 || ctx.clip_ms <= 0 {
            return None;
        }
        let en = match (e.in_ms, e.out_ms) {
            (None, None) => String::new(),
            (a, b) => format!(
                ":enable='between(t,{},{})'",
                fxlib::fmt_num(a.map_or(0.0, |v| v / 1000.0)),
                fxlib::fmt_num(b.map_or(1.0e9, |v| v / 1000.0))
            ),
        };
        return Some(match e.kind.as_str() {
            "lensFlare" => lens_flare_frag(e, ctx, i, &en, &p),
            "lightLeak" => light_leak_frag(e, ctx, i, &en, &p),
            "godRays" => god_rays_frag(e, ctx, i, &en, &p),
            "prismRefraction" => prism_frag(e, ctx, i, &en, &p),
            "floatingDust" => floating_dust_frag(e, ctx, i, &en, &p),
            "starGlint" => star_glint_frag(e, ctx, i, &en, &p),
            "neonTrails" => neon_trails_frag(e, ctx, i, &en, &p),
            "goldenRays" => golden_rays_frag(e, ctx, i, &en, &p),
            "floatingEmbers" => floating_embers_frag(e, ctx, i, &en, &p),
            "cinematicFog" => cinematic_fog_frag(e, ctx, i, &en, &p),
            "fireflies" => fireflies_frag(e, ctx, i, &en, &p),
            _ => falling_snow_frag(e, ctx, i, &en, &p),
        });
    }
    // Field-driven intro/outro effects (manifest render.kind="fields"):
    // declarative ax/ay/m/glow evaluated per frame — same recipe the
    // GLSL preview and the transition fields engine share.
    if let Some(fxlib::FxRender::Fields { div, fields }) = entry.render.as_ref() {
        return effect_fields_frag(e, ctx, entry, *div, fields).map(|s| vec![s]);
    }
    match e.kind.as_str() {
        "focusPull" => focus_pull_frag(e, ctx, &p),
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

    #[test]
    fn dump_light_fragments() {
        // cargo test dump_light_fragments -- --nocapture — prints the real
        // fragment chains for manual ffmpeg validation.
        let c = FxCtx { w: 640, h: 360, fps_num: 30, fps_den: 1, clip_ms: 2000, source_in_ms: 0, speed: 1.0 };
        for kind in ["lensFlare", "lightLeak", "godRays", "prismRefraction"] {
            let f = fragments(&fx(kind, &[], None), &c).unwrap();
            eprintln!("── {kind}\n{}", f.join(";\n"));
        }
    }

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
