//! Effect registry — canonical parameters shared by preview and render.
//!
//! Every effect maps to an ffmpeg filter fragment whose numeric behavior is
//! matched by the preview side (`src/lib/effects.ts` → CSS `filter:` or SVG
//! `feColorMatrix`). Parity is verified against rendered pixels in
//! `tests/render_e2e.rs` — the formulas below are chosen to be *exactly*
//! expressible in both worlds, not merely similar:
//!
//! | kind        | param   | ffmpeg                          | preview            |
//! |-------------|---------|---------------------------------|--------------------|
//! | brightness  | amount  | colorchannelmixer rr=gg=bb=1+a  | CSS brightness(1+a)|
//! | exposure    | stops   | colorchannelmixer rr=gg=bb=2^s  | CSS brightness(2^s)|
//! | contrast    | amount  | lutrgb affine pivot .5          | CSS contrast(1+a)  |
//! | saturation  | amount  | colorchannelmixer W3C matrix    | CSS saturate(1+a)  |
//! | temperature | amount  | colorchannelmixer diag matrix   | SVG feColorMatrix  |
//! | blur        | radius  | gblur sigma=radius              | CSS blur(radius)   |
//! | grayscale   | amount  | saturate matrix s=1-a           | CSS grayscale(a)   |
//! | sepia       | amount  | interpolated sepia matrix       | CSS sepia(a)       |
//! | invert      | amount  | lutrgb val*(1-2a)+255a          | CSS invert(a)      |
//! | hueRotate   | deg     | hue h=deg                       | CSS hue-rotate(deg)|
//! | sharpen     | amount  | unsharp 5:5:a                   | feConvolveMatrix   |
//! | vignette    | amount  | vignette angle=PI/2-a*PI/3      | inset box-shadow   |
//! | grain       | amount  | noise alls=40a, temporal        | SVG feTurbulence   |
//!
//! Unknown kinds are ignored (forward-compat), never fail the render.

use crate::project::document::Effect;

fn param(e: &Effect, key: &str, def: f64) -> f64 {
    e.params.get(key).copied().unwrap_or(def)
}

/// W3C filter-effects saturate() matrix — the exact same coefficients CSS
/// uses, expressed as a colorchannelmixer so output is bit-identical.
fn saturation_matrix(s: f64) -> String {
    let rr = 0.213 + 0.787 * s;
    let rg = 0.715 - 0.715 * s;
    let rb = 0.072 - 0.072 * s;
    let gr = 0.213 - 0.213 * s;
    let gg = 0.715 + 0.285 * s;
    let gb = 0.072 - 0.072 * s;
    let br = 0.213 - 0.213 * s;
    let bg = 0.715 - 0.715 * s;
    let bb = 0.072 + 0.928 * s;
    format!(
        "colorchannelmixer=rr={rr}:rg={rg}:rb={rb}:gr={gr}:gg={gg}:gb={gb}:br={br}:bg={bg}:bb={bb}"
    )
}

/// Wrap a filter fragment in an activation window when the effect carries
/// in/out ms (clip-relative; setpts already reset this layer's PTS to 0).
fn with_enable(e: &Effect, frag: String) -> String {
    let cond = match (e.in_ms, e.out_ms) {
        (None, None) => return frag,
        (Some(a), Some(b)) => format!("between(t,{},{})", a / 1000.0, b / 1000.0),
        (Some(a), None) => format!("gte(t,{})", a / 1000.0),
        (None, Some(b)) => format!("lt(t,{})", b / 1000.0),
    };
    format!("{}:enable='{}'", frag, cond)
}

/// Ordered ffmpeg filter fragment for a clip's enabled effect stack.
/// Returns "" when nothing applies.
pub fn effects_chain(effects: &[Effect]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for e in effects.iter().filter(|e| e.enabled) {
        let frag = match e.kind.as_str() {
            "brightness" => {
                let f = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                format!("colorchannelmixer=rr={f}:gg={f}:bb={f}")
            }
            "exposure" => {
                let f = 2f64.powf(param(e, "stops", 0.0)).clamp(0.0, 16.0);
                format!("colorchannelmixer=rr={f}:gg={f}:bb={f}")
            }
            "contrast" => {
                // CSS contrast(c) is an exact per-channel affine map:
                // out = clip(in*c + 255*(0.5-0.5c), 0, 255). A two-point
                // curves line collapses to identity for c≤2 — lutrgb is
                // the direct equivalent (parity with CSS contrast(1+a)).
                let c = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                let k = 255.0 * (0.5 - 0.5 * c);
                format!("lutrgb=r='clip(val*{c}+{k},0,255)':g='clip(val*{c}+{k},0,255)':b='clip(val*{c}+{k},0,255)'")
            }
            "saturation" => {
                let s = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                saturation_matrix(s)
            }
            "temperature" => {
                // Canonical white-balance shift, amount ∈ [-1,1]:
                // warm = red up, blue down; cool = inverse.
                let t = param(e, "amount", 0.0).clamp(-1.0, 1.0);
                let (r, g, b) = (1.0 + 0.15 * t, 1.0 - 0.05 * t, 1.0 - 0.15 * t);
                format!("colorchannelmixer=rr={r}:gg={g}:bb={b}")
            }
            "blur" => {
                let px = param(e, "radius", 0.0).clamp(0.0, 500.0);
                if px <= 0.0 {
                    continue;
                }
                format!("gblur=sigma={px}")
            }
            "grayscale" => {
                // CSS grayscale(a) === saturate(1-a) — same luminance matrix.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                saturation_matrix(1.0 - a)
            }
            "sepia" => {
                // W3C sepia matrix interpolated identity→full by amount:
                // m = I + a*(S − I), as colorchannelmixer coefficients.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                let (rr, rg, rb) = (1.0 - 0.607 * a, 0.769 * a, 0.189 * a);
                let (gr, gg, gb) = (0.349 * a, 1.0 - 0.314 * a, 0.168 * a);
                let (br, bg, bb) = (0.272 * a, 0.534 * a, 1.0 - 0.869 * a);
                format!(
                    "colorchannelmixer=rr={rr}:rg={rg}:rb={rb}:gr={gr}:gg={gg}:gb={gb}:br={br}:bg={bg}:bb={bb}"
                )
            }
            "invert" => {
                // CSS invert(a) is an exact per-channel affine map:
                // out = val*(1-2a) + 255a — no clipping needed in 0..=1.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                let (m, k) = (1.0 - 2.0 * a, 255.0 * a);
                format!("lutrgb=r='val*{m}+{k}':g='val*{m}+{k}':b='val*{m}+{k}'")
            }
            "hueRotate" => {
                let deg = param(e, "deg", 45.0).clamp(-360.0, 360.0);
                format!("hue=h={deg}")
            }
            "sharpen" => {
                let a = param(e, "amount", 1.0).clamp(0.0, 3.0);
                if a <= 0.0 {
                    continue;
                }
                format!("unsharp=5:5:{a}")
            }
            "vignette" => {
                // angle: PI/2 (subtle) → PI/6 (strong) as amount goes 0→1.
                let a = param(e, "amount", 0.5).clamp(0.0, 1.0);
                if a <= 0.01 {
                    continue;
                }
                let ang = std::f64::consts::FRAC_PI_2 - a * std::f64::consts::FRAC_PI_3;
                format!("vignette=angle={ang}")
            }
            "grain" => {
                let a = param(e, "amount", 0.35).clamp(0.0, 1.0);
                if a <= 0.0 {
                    continue;
                }
                format!("noise=alls={}:allf=t+u", (a * 40.0).round() as i32)
            }
            _ => continue,
        };
        parts.push(with_enable(e, frag));
    }
    parts.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::document::Effect;
    use std::collections::BTreeMap;

    fn fx(kind: &str, params: &[(&str, f64)]) -> Effect {
        Effect {
            id: "e1".into(),
            kind: kind.into(),
            enabled: true,
            in_ms: None,
            out_ms: None,
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    #[test]
    fn windowed_effect_gets_enable() {
        let mut e = fx("brightness", &[("amount", 0.5)]);
        e.in_ms = Some(1000.0);
        e.out_ms = Some(2000.0);
        let c = effects_chain(std::slice::from_ref(&e));
        assert!(c.contains("enable='between(t,1,2)'"), "{c}");
        // Unbounded edges map to gte/lt; no window → no enable clause.
        e.out_ms = None;
        let c2 = effects_chain(std::slice::from_ref(&e));
        assert!(c2.contains("enable='gte(t,1)'"), "{c2}");
        e.in_ms = None;
        let c3 = effects_chain(std::slice::from_ref(&e));
        assert!(!c3.contains("enable"), "{c3}");
    }

    #[test]
    fn brightness_maps_to_multiply() {
        let c = effects_chain(&[fx("brightness", &[("amount", 0.5)])]);
        assert!(c.contains("colorchannelmixer=rr=1.5:gg=1.5:bb=1.5"));
    }

    #[test]
    fn contrast_maps_to_affine_lut() {
        // CSS contrast(2): out = val*2 - 127.5 — must NOT be identity.
        let c = effects_chain(&[fx("contrast", &[("amount", 1.0)])]);
        assert!(c.contains("lutrgb"), "{c}");
        assert!(c.contains("val*2"), "{c}");
        assert!(c.contains("-127.5"), "{c}");
        // amount=0.25 → c=1.25, k=-31.875 — still a real ramp, not '0/0 1/1'.
        let s = effects_chain(&[fx("contrast", &[("amount", 0.25)])]);
        assert!(s.contains("val*1.25"), "{s}");
    }

    #[test]
    fn new_color_effects_map() {
        // grayscale(1) → saturate(0) luminance matrix
        let g = effects_chain(&[fx("grayscale", &[("amount", 1.0)])]);
        assert!(g.contains("colorchannelmixer") && g.contains("0.213"), "{g}");
        // sepia(1) → full W3C sepia matrix
        let s = effects_chain(&[fx("sepia", &[("amount", 1.0)])]);
        assert!(s.contains("0.393") || s.contains("0.769"), "{s}");
        // invert(1) → full negation
        let i = effects_chain(&[fx("invert", &[("amount", 1.0)])]);
        assert!(i.contains("lutrgb") && i.contains("-1") && i.contains("255"), "{i}");
        // hueRotate → hue filter
        let h = effects_chain(&[fx("hueRotate", &[("deg", 45.0)])]);
        assert!(h.contains("hue=h=45"), "{h}");
        // sharpen / grain / vignette emit their filters; zero params skip
        assert!(effects_chain(&[fx("sharpen", &[("amount", 1.5)])]).contains("unsharp"));
        assert!(effects_chain(&[fx("grain", &[("amount", 0.5)])]).contains("noise=alls=20"));
        assert!(effects_chain(&[fx("vignette", &[("amount", 0.5)])]).contains("vignette"));
        assert!(effects_chain(&[fx("grain", &[("amount", 0.0)])]).is_empty());
        assert!(effects_chain(&[fx("blur", &[("radius", 0.0)])]).is_empty());
    }

    #[test]
    fn order_is_preserved() {
        let c = effects_chain(&[
            fx("brightness", &[("amount", 0.2)]),
            fx("blur", &[("radius", 4.0)]),
        ]);
        let bi = c.find("colorchannelmixer").unwrap();
        let bl = c.find("gblur").unwrap();
        assert!(bi < bl);
    }

    #[test]
    fn disabled_and_unknown_are_skipped() {
        let mut e = fx("blur", &[("radius", 4.0)]);
        e.enabled = false;
        assert_eq!(effects_chain(&[e, fx("nonsense", &[])]), "");
    }
}
