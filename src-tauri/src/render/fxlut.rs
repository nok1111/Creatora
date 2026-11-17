//! Filter LUT baker — Rust mirror of `src/lib/fx/lut.ts`.
//!
//! Both sides evaluate the same `lut` ops on the 33³ grid: TS produces the
//! GL 3D texture, this produces the `.cube` file fed to ffmpeg `lut3d`
//! (`interp=trilinear` — identical interpolation to the GL texture). The
//! formulas below must stay line-equivalent to the TS implementation; the
//! sparse golden (`shared/fx/lut-golden.json`) pins both within 1e-4
//! (libm can differ by 1 ulp between runtimes).
//!
//! Grid order (.cube convention): blue-major, green-middle, red-fastest.
//! Intensity is baked in (mix with identity) — linear ops commute with the
//! trilinear sampler, so it equals `mix(c, lut(c), i)` in the shader.

use super::fxlib;
use serde::Deserialize;
use std::collections::BTreeMap;

pub const LUT_SIZE: usize = 33;
const LUT_NODES: usize = LUT_SIZE * LUT_SIZE * LUT_SIZE;

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum LutNum {
    V(f64),
    Ref(String),
}

impl LutNum {
    fn v(&self, k: &BTreeMap<String, f64>) -> f64 {
        match self {
            LutNum::V(v) => *v,
            LutNum::Ref(name) => {
                let key = name.trim_start_matches('{').trim_end_matches('}');
                k.get(key).copied().unwrap_or(0.0)
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum LutOp {
    Temp { amt: LutNum },
    Tint { amt: LutNum },
    Sat { amt: LutNum },
    Vib { amt: LutNum },
    Lgg { lift: [LutNum; 3], gamma: [LutNum; 3], gain: [LutNum; 3] },
    Curve { ch: LutNum, pts: Vec<(f64, f64)> },
    Split { sh: [LutNum; 2], hi: [LutNum; 2] },
    Mixer { m: Vec<Vec<f64>> },
    Hsl { hue: LutNum, range: LutNum, dh: LutNum, ds: LutNum, dl: LutNum },
    Fade { amt: LutNum },
    Levels {
        #[serde(rename = "inB")]
        in_b: LutNum,
        #[serde(rename = "inW")]
        in_w: LutNum,
        #[serde(rename = "outB")]
        out_b: LutNum,
        #[serde(rename = "outW")]
        out_w: LutNum,
        gamma: LutNum,
    },
}

type V3 = [f64; 3];
const LUMA: V3 = [0.2126, 0.7152, 0.0722];
#[inline]
fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}
#[inline]
fn luma(c: V3) -> f64 {
    c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
}

fn rgb2hsl(c: V3) -> V3 {
    let (r, g, b) = (c[0], c[1], c[2]);
    let mx = r.max(g).max(b);
    let mn = r.min(g).min(b);
    let l = (mx + mn) / 2.0;
    if mx == mn {
        return [0.0, 0.0, l];
    }
    let d = mx - mn;
    let s = if l > 0.5 { d / (2.0 - mx - mn) } else { d / (mx + mn) };
    let h = if mx == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
    } else if mx == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    [h, s, l]
}

fn hsl2rgb([h, s, l]: V3) -> V3 {
    if s == 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let f = |t0: f64| {
        let mut t = t0;
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 1.0 / 2.0 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0)]
}

/// Monotone cubic (Fritsch–Carlson PCHIP) — identical to lut.ts.
fn pchip(pts: &[(f64, f64)]) -> Box<dyn Fn(f64) -> f64 + '_> {
    let n = pts.len();
    let xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = pts.iter().map(|p| p.1).collect();
    let mut d = Vec::with_capacity(n.saturating_sub(1));
    let mut m = Vec::with_capacity(n);
    for i in 0..n.saturating_sub(1) {
        d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    }
    if n == 1 {
        return Box::new(move |_| ys[0]);
    }
    m.push(d[0]);
    for i in 1..n - 1 {
        m.push(if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 });
    }
    m.push(d[n - 2]);
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let a = m[i] / d[i];
            let b = m[i + 1] / d[i];
            let h = (a * a + b * b).sqrt();
            if h > 3.0 {
                m[i] = 3.0 * a / h * d[i];
                m[i + 1] = 3.0 * b / h * d[i];
            }
        }
    }
    Box::new(move |x: f64| {
        if x <= xs[0] {
            return ys[0];
        }
        if x >= xs[n - 1] {
            return ys[n - 1];
        }
        let mut i = 0;
        while i < n - 2 && x > xs[i + 1] {
            i += 1;
        }
        let dx = xs[i + 1] - xs[i];
        let t = (x - xs[i]) / dx;
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * ys[i]
            + (t3 - 2.0 * t2 + t) * dx * m[i]
            + (-2.0 * t3 + 3.0 * t2) * ys[i + 1]
            + (t3 - t2) * dx * m[i + 1]
    })
}

fn vec3(v: &[LutNum; 3], k: &BTreeMap<String, f64>) -> V3 {
    [v[0].v(k), v[1].v(k), v[2].v(k)]
}

fn apply_op(c: V3, op: &LutOp, k: &BTreeMap<String, f64>) -> V3 {
    match op {
        LutOp::Temp { amt } => {
            let a = amt.v(k);
            [
                clamp01(c[0] * (1.0 + 0.3 * a)),
                clamp01(c[1] * (1.0 + 0.06 * a)),
                clamp01(c[2] * (1.0 - 0.3 * a)),
            ]
        }
        LutOp::Tint { amt } => {
            let a = amt.v(k);
            [
                clamp01(c[0] * (1.0 + 0.12 * a)),
                clamp01(c[1] * (1.0 - 0.22 * a)),
                clamp01(c[2] * (1.0 + 0.12 * a)),
            ]
        }
        LutOp::Sat { amt } => {
            let a = amt.v(k);
            let l = luma(c);
            [0, 1, 2].map(|i| clamp01(l + (c[i] - l) * a))
        }
        LutOp::Vib { amt } => {
            let a = amt.v(k);
            let mx = c[0].max(c[1]).max(c[2]);
            let mn = c[0].min(c[1]).min(c[2]);
            let s = if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
            let l = luma(c);
            let f = 1.0 + a * (1.0 - s);
            [0, 1, 2].map(|i| clamp01(l + (c[i] - l) * f))
        }
        LutOp::Lgg { lift, gamma, gain } => {
            let (lift, gamma, gain) = (vec3(lift, k), vec3(gamma, k), vec3(gain, k));
            [0, 1, 2].map(|i| {
                let x = clamp01(c[i] * (gain[i] - lift[i]) + lift[i]);
                clamp01(x.powf(1.0 / gamma[i].max(0.05)))
            })
        }
        LutOp::Curve { ch, pts } => {
            let f = pchip(pts);
            let ch = ch.v(k).round() as usize;
            if ch >= 3 {
                let l = luma(c);
                let nl = clamp01(f(clamp01(l)));
                let d = nl - l;
                [
                    clamp01(c[0] + d),
                    clamp01(c[1] + d),
                    clamp01(c[2] + d),
                ]
            } else {
                let mut out = c;
                out[ch] = clamp01(f(clamp01(c[ch])));
                out
            }
        }
        LutOp::Split { sh, hi } => {
            let l = luma(c);
            let (sh_h, sh_s) = (sh[0].v(k), sh[1].v(k));
            let (hi_h, hi_s) = (hi[0].v(k), hi[1].v(k));
            let norm = |h: f64| h.rem_euclid(360.0) / 360.0;
            let sh_t = hsl2rgb([norm(sh_h), (sh_s * 2.0).min(1.0), l]);
            let hi_t = hsl2rgb([norm(hi_h), hi_s.min(1.0) * 2.0, l]);
            let w_s = (1.0 - l) * sh_s.min(1.0);
            let w_h = l * hi_s.min(1.0);
            [0, 1, 2].map(|i| clamp01(c[i] * (1.0 - w_s - w_h) + sh_t[i] * w_s + hi_t[i] * w_h))
        }
        LutOp::Mixer { m } => [0, 1, 2].map(|i| clamp01(c[0] * m[i][0] + c[1] * m[i][1] + c[2] * m[i][2])),
        LutOp::Hsl { hue, range, dh, ds, dl } => {
            let (hue0, range, dh, ds, dl) =
                (hue.v(k), range.v(k), dh.v(k), ds.v(k), dl.v(k));
            let hsl = rgb2hsl(c);
            let mut dhue = (hsl[0] * 360.0 - hue0).abs();
            dhue = dhue.min(360.0 - dhue);
            let w = (-(dhue / range.max(1e-3)).powi(2)).exp();
            let h = (hsl[0] + dh * w / 360.0).rem_euclid(1.0);
            let s = clamp01(hsl[1] * (1.0 + (ds - 1.0) * w));
            let l = clamp01(hsl[2] + dl * w);
            hsl2rgb([h, s, l])
        }
        LutOp::Fade { amt } => {
            let a = amt.v(k);
            [0, 1, 2].map(|i| clamp01(c[i] * (1.0 - a) + a * (0.14 + 0.75 * c[i])))
        }
        LutOp::Levels { in_b, in_w, out_b, out_w, gamma } => {
            let (ib, iw, ob, ow, g) =
                (in_b.v(k), in_w.v(k), out_b.v(k), out_w.v(k), gamma.v(k));
            let span = (iw - ib).max(1e-3);
            [0, 1, 2].map(|i| {
                let x = clamp01((c[i] - ib) / span).powf(1.0 / g.max(0.05));
                clamp01(ob + x * (ow - ob))
            })
        }
    }
}

pub fn apply_lut(c: V3, ops: &[LutOp], k: &BTreeMap<String, f64>) -> V3 {
    let mut c = c;
    for op in ops {
        c = apply_op(c, op, k);
    }
    c
}

/// Baked grid value at node `idx` (blue-major, red-fastest), intensity-mixed.
pub fn lut_node(ops: &[LutOp], k: &BTreeMap<String, f64>, intensity: f64, idx: usize) -> V3 {
    let s = LUT_SIZE as f64 - 1.0;
    let b = idx / (LUT_SIZE * LUT_SIZE);
    let g = (idx / LUT_SIZE) % LUT_SIZE;
    let r = idx % LUT_SIZE;
    let c: V3 = [r as f64 / s, g as f64 / s, b as f64 / s];
    let t = if ops.is_empty() { c } else { apply_lut(c, ops, k) };
    [
        c[0] + (t[0] - c[0]) * intensity,
        c[1] + (t[1] - c[1]) * intensity,
        c[2] + (t[2] - c[2]) * intensity,
    ]
}

/// One .cube number: plain text, no parens (LUT values live in 0..1).
fn fmt_cube(v: f64) -> String {
    let mut s = if v == v.trunc() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        let t = format!("{v:.6}");
        t.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    if s == "-0" {
        s = "0".into();
    }
    s
}

/// The .cube text for a filter entry — same format the TS baker emits.
pub fn bake_cube_text(
    entry: &fxlib::FxEntry,
    consts: &BTreeMap<String, f64>,
) -> String {
    let intensity = (consts.get("intensity").copied().unwrap_or(100.0) / 100.0).clamp(0.0, 1.0);
    let ops: &[LutOp] = entry.lut.as_deref().unwrap_or(&[]);
    let mut out = format!("LUT_3D_SIZE {LUT_SIZE}\n# {}\n", entry.id);
    for i in 0..LUT_NODES {
        let v = lut_node(ops, consts, intensity, i);
        out.push_str(&fmt_cube(v[0]));
        out.push(' ');
        out.push_str(&fmt_cube(v[1]));
        out.push(' ');
        out.push_str(&fmt_cube(v[2]));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins Rust↔TS parity: the same grid nodes the vitest golden wrote
    /// (`UPDATE_GOLDEN=1 npx vitest run src/lib/fx/fx.test.ts`).
    #[test]
    fn lut_golden_matches_ts() {
        let doc: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/fx/lut-golden.json"
        ))
        .unwrap();
        for (id, nodes) in doc.as_object().unwrap() {
            let entry = fxlib::entry(id).unwrap();
            let consts = fxlib::resolve_constants(entry, &BTreeMap::new());
            let intensity = (consts["intensity"] / 100.0).clamp(0.0, 1.0);
            for (key, want) in nodes.as_object().unwrap() {
                let p: Vec<usize> = key.split(',').map(|x| x.parse().unwrap()).collect();
                let idx = (p[2] * LUT_SIZE + p[1]) * LUT_SIZE + p[0];
                let got = lut_node(entry.lut.as_deref().unwrap_or(&[]), &consts, intensity, idx);
                let want = want.as_array().unwrap();
                for i in 0..3 {
                    let w = want[i].as_f64().unwrap();
                    assert!(
                        (got[i] - w).abs() < 1e-4,
                        "{id} node {key} ch{i}: rust {} vs ts {w}",
                        got[i]
                    );
                }
            }
        }
    }

    #[test]
    fn cube_text_is_wellformed() {
        let entry = fxlib::entry("tealOrange").unwrap();
        let consts = fxlib::resolve_constants(entry, &BTreeMap::new());
        let text = bake_cube_text(entry, &consts);
        let lines: Vec<&str> = text.trim().lines().collect();
        assert_eq!(lines[0], "LUT_3D_SIZE 33");
        assert_eq!(lines.len(), 1 + 1 + LUT_NODES);
        assert!(lines[2..].iter().all(|l| l.split(' ').count() == 3));
    }

    #[test]
    fn zero_intensity_is_identity() {
        let entry = fxlib::entry("tealOrange").unwrap();
        let consts = fxlib::resolve_constants(entry, &BTreeMap::new());
        for &idx in &[0usize, 16 * 33 + 4, LUT_NODES / 2, LUT_NODES - 1] {
            let v = lut_node(entry.lut.as_deref().unwrap(), &consts, 0.0, idx);
            let s = LUT_SIZE as f64 - 1.0;
            let (b, g, r) = (idx / (33 * 33), (idx / 33) % 33, idx % 33);
            assert!((v[0] - r as f64 / s).abs() < 1e-9);
            assert!((v[1] - g as f64 / s).abs() < 1e-9);
            assert!((v[2] - b as f64 / s).abs() < 1e-9);
        }
    }
}
