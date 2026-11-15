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
//! | contrast    | amount  | lutrgb affine pivot .5          | CSS contrast(1+a)  |
//! | saturation  | amount  | colorchannelmixer W3C matrix    | CSS saturate(1+a)  |
//! | blur        | radius  | gblur sigma=radius              | CSS blur(radius)   |
//! | grayscale   | amount  | saturate matrix s=1-a           | CSS grayscale(a)   |
//! | sepia       | amount  | interpolated sepia matrix       | CSS sepia(a)       |
//! | invert      | amount  | lutrgb val*(1-2a)+255a          | CSS invert(a)      |
//! | hueRotate   | deg     | hue h=deg                       | CSS hue-rotate(deg)|
//! | sharpen     | amount  | unsharp 5:5:a                   | feConvolveMatrix   |
//! | vignette    | amount  | vignette angle=PI/2-a*PI/3      | inset box-shadow   |
//! | grain       | amount  | noise alls=40a, temporal        | SVG feTurbulence   |
//! | channelSwap | amount  | mixer R↔B interpolated          | feColorMatrix      |
//! | posterize   | levels  | lutrgb floor staircase          | feFunc* discrete   |
//! | scanlines   | strength| geq darken every 3rd row        | gradient overlay   |
//! | rgbShift    | shift   | rgbashift rh=+s bh=-s smear     | feOffset channels  |
//! | edges       | amount  | edgedetect colormix             | feConvolveMatrix   |
//! | filmNoir    | amount  | sat-matrix + contrast + vignette| css + box-shadow   |
//! | dreamGlow   | amount  | gblur + lift + sat              | css trio           |
//! | blockbuster | amount  | teal-orange mixer               | feColorMatrix      |
//! | matteFade   | amount  | lutrgb lift + desat             | css trio           |
//! | popColor    | amount  | sat matrix + contrast           | css pair           |
//! | retro       | amount  | lift + sepia-mix + desat + grain| css + turbulence   |
//! | crt         | amount  | rgbashift + desat + geq + vign  | css+svg+overlay    |
//! | vhs         | amount  | full tape chain (6 frags)       | css+svg+overlay    |
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

/// Ordered ffmpeg filter fragments for a clip's enabled effect stack.
/// Compound looks emit several fragments — each gets its own `enable`
/// window (a single trailing clause would only gate the last filter).
/// Returns "" when nothing applies.
pub fn effects_chain(effects: &[Effect]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for e in effects.iter().filter(|e| e.enabled) {
        let frags: Vec<String> = match e.kind.as_str() {
            "brightness" => {
                let f = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                vec![format!("colorchannelmixer=rr={f}:gg={f}:bb={f}")]
            }
            "contrast" => {
                // CSS contrast(c) is an exact per-channel affine map:
                // out = clip(in*c + 255*(0.5-0.5c), 0, 255).
                let c = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                let k = 255.0 * (0.5 - 0.5 * c);
                vec![format!("lutrgb=r='clip(val*{c}+{k},0,255)':g='clip(val*{c}+{k},0,255)':b='clip(val*{c}+{k},0,255)'")]
            }
            "saturation" => {
                let s = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                vec![saturation_matrix(s)]
            }
            "blur" => {
                let px = param(e, "radius", 0.0).clamp(0.0, 500.0);
                if px <= 0.0 {
                    continue;
                }
                vec![format!("gblur=sigma={px}")]
            }
            "grayscale" => {
                // CSS grayscale(a) === saturate(1-a) — same luminance matrix.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                vec![saturation_matrix(1.0 - a)]
            }
            "sepia" => {
                // W3C sepia matrix interpolated identity→full by amount.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                let (rr, rg, rb) = (1.0 - 0.607 * a, 0.769 * a, 0.189 * a);
                let (gr, gg, gb) = (0.349 * a, 1.0 - 0.314 * a, 0.168 * a);
                let (br, bg, bb) = (0.272 * a, 0.534 * a, 1.0 - 0.869 * a);
                vec![format!(
                    "colorchannelmixer=rr={rr}:rg={rg}:rb={rb}:gr={gr}:gg={gg}:gb={gb}:br={br}:bg={bg}:bb={bb}"
                )]
            }
            "invert" => {
                // CSS invert(a) is an exact per-channel affine map.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                let (m, k) = (1.0 - 2.0 * a, 255.0 * a);
                vec![format!("lutrgb=r='val*{m}+{k}':g='val*{m}+{k}':b='val*{m}+{k}'")]
            }
            "hueRotate" => {
                let deg = param(e, "deg", 45.0).clamp(-360.0, 360.0);
                vec![format!("hue=h={deg}")]
            }
            "sharpen" => {
                let a = param(e, "amount", 1.0).clamp(0.0, 3.0);
                if a <= 0.0 {
                    continue;
                }
                vec![format!("unsharp=5:5:{a}")]
            }
            "vignette" => {
                // angle: PI/2 (subtle) → PI/6 (strong) as amount goes 0→1.
                let a = param(e, "amount", 0.5).clamp(0.0, 1.0);
                if a <= 0.01 {
                    continue;
                }
                let ang = std::f64::consts::FRAC_PI_2 - a * std::f64::consts::FRAC_PI_3;
                vec![format!("vignette=angle={ang}")]
            }
            "grain" => {
                let a = param(e, "amount", 0.35).clamp(0.0, 1.0);
                if a <= 0.0 {
                    continue;
                }
                vec![format!("noise=alls={}:allf=t+u", (a * 40.0).round() as i32)]
            }
            "channelSwap" => {
                // R↔B swap interpolated identity→full (aerochrome vibe).
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                let i = 1.0 - a;
                vec![format!(
                    "colorchannelmixer=rr={i}:rg=0:rb={a}:gr=0:gg=1:gb=0:br={a}:bg=0:bb={i}"
                )]
            }
            "posterize" => {
                // Staircase quantize — same steps as the SVG discrete table.
                let l = param(e, "levels", 8.0).clamp(2.0, 64.0);
                let step = 255.0 / (l - 1.0);
                vec![format!(
                    "lutrgb=r='floor(val/{step}+0.5)*{step}':g='floor(val/{step}+0.5)*{step}':b='floor(val/{step}+0.5)*{step}'"
                )]
            }
            "scanlines" => {
                // Darken every 3rd row — the CRT/VHS signature.
                let a = param(e, "strength", 0.4).clamp(0.0, 1.0);
                if a <= 0.0 {
                    continue;
                }
                let f = format!("(1-{a}*eq(mod(Y,3),0))");
                vec![format!(
                    "geq=r='r(X,Y)*{f}':g='g(X,Y)*{f}':b='b(X,Y)*{f}'"
                )]
            }
            "rgbShift" => {
                let s = param(e, "shift", 6.0).clamp(0.0, 100.0);
                if s <= 0.0 {
                    continue;
                }
                vec![format!("rgbashift=rh={s}:bh={}:edge=smear", -s)]
            }
            "edges" => {
                let a = param(e, "amount", 0.5).clamp(0.0, 1.0);
                vec![format!(
                    "edgedetect=low={}:high={}:mode=colormix",
                    0.04 + 0.12 * a,
                    0.15 + 0.35 * a
                )]
            }
            "filmNoir" => {
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                vec![
                    saturation_matrix(1.0 - a),
                    "lutrgb=r='clip(val*1.35+-44.625,0,255)':g='clip(val*1.35+-44.625,0,255)':b='clip(val*1.35+-44.625,0,255)'".to_string(),
                    format!("vignette=angle={}", std::f64::consts::FRAC_PI_2 - 0.5 * std::f64::consts::FRAC_PI_3),
                ]
            }
            "dreamGlow" => {
                // Orton-lite: soft blur + lifted luminance + slight sat.
                let a = param(e, "amount", 0.5).clamp(0.0, 1.0);
                if a <= 0.0 {
                    continue;
                }
                let lift = 1.0 + 0.24 * a;
                vec![
                    format!("gblur=sigma={:.2}", a * 5.0),
                    format!("colorchannelmixer=rr={lift}:gg={lift}:bb={lift}"),
                    saturation_matrix(1.0 + 0.2 * a),
                ]
            }
            "blockbuster" => {
                // Teal shadows / orange highlights — same matrix as preview.
                let a = param(e, "amount", 1.0).clamp(0.0, 1.0);
                let l = |from: f64, to: f64| from + (to - from) * a;
                vec![format!(
                    "colorchannelmixer=rr={}:rg=0:rb={}:gr={}:gg=1:gb=0:br={}:bg={}:bb={}",
                    l(1.0, 1.15), l(0.0, -0.08), l(0.0, -0.02),
                    l(0.0, 0.08), l(0.0, 0.02), l(1.0, 0.92)
                )]
            }
            "matteFade" => {
                // Lifted blacks + gentle desat.
                let a = param(e, "amount", 0.7).clamp(0.0, 1.0);
                let c = 1.0 - 0.15 * a;
                let k = 255.0 * 0.12 * a;
                vec![
                    format!("lutrgb=r='clip(val*{c}+{k},0,255)':g='clip(val*{c}+{k},0,255)':b='clip(val*{c}+{k},0,255)'"),
                    saturation_matrix(1.0 - 0.2 * a),
                ]
            }
            "popColor" => {
                let a = param(e, "amount", 0.5).clamp(0.0, 1.0);
                let c = 1.0 + 0.24 * a;
                let k = 255.0 * (0.5 - 0.5 * c);
                vec![
                    saturation_matrix(1.0 + 1.1 * a),
                    format!("lutrgb=r='clip(val*{c}+{k},0,255)':g='clip(val*{c}+{k},0,255)':b='clip(val*{c}+{k},0,255)'"),
                ]
            }
            "retro" => {
                // Lift + warm sepia mix + desat + light grain.
                let a = param(e, "amount", 0.8).clamp(0.0, 1.0);
                let (rr, rg, rb) = (1.0 - 0.607 * 0.35 * a, 0.769 * 0.35 * a, 0.189 * 0.35 * a);
                let (gr, gg, gb) = (0.349 * 0.35 * a, 1.0 - 0.314 * 0.35 * a, 0.168 * 0.35 * a);
                let (br, bg, bb) = (0.272 * 0.35 * a, 0.534 * 0.35 * a, 1.0 - 0.869 * 0.35 * a);
                vec![
                    "lutrgb=r='clip(val*0.95+14,0,255)':g='clip(val*0.95+14,0,255)':b='clip(val*0.95+14,0,255)'".to_string(),
                    format!("colorchannelmixer=rr={rr}:rg={rg}:rb={rb}:gr={gr}:gg={gg}:gb={gb}:br={br}:bg={bg}:bb={bb}"),
                    saturation_matrix(1.0 - 0.25 * a),
                    format!("noise=alls={}:allf=t+u", (a * 14.0).round() as i32),
                ]
            }
            "crt" => {
                // RGB bleed + scanlines + desat — monitor phospors.
                let a = param(e, "amount", 0.6).clamp(0.0, 1.0);
                let s = 2.5 * a;
                let f = format!("(1-{}*eq(mod(Y,3),0))", 0.5 * a);
                vec![
                    format!("rgbashift=rh={s}:bh={}:edge=smear", -s),
                    saturation_matrix(1.0 - 0.25 * a),
                    format!("geq=r='r(X,Y)*{f}':g='g(X,Y)*{f}':b='b(X,Y)*{f}'"),
                    format!("vignette=angle={}", std::f64::consts::FRAC_PI_2 - 0.45 * a * std::f64::consts::FRAC_PI_3),
                ]
            }
            "vhs" => {
                // The full tape: RGB bleed + lift+sepia+desat + grain + lines.
                let a = param(e, "amount", 0.7).clamp(0.0, 1.0);
                let s = 4.0 * a;
                let f = format!("(1-{}*eq(mod(Y,3),0))", 0.4 * a);
                let (rr, rg, rb) = (1.0 - 0.607 * 0.3 * a, 0.769 * 0.3 * a, 0.189 * 0.3 * a);
                let (gr, gg, gb) = (0.349 * 0.3 * a, 1.0 - 0.314 * 0.3 * a, 0.168 * 0.3 * a);
                let (br, bg, bb) = (0.272 * 0.3 * a, 0.534 * 0.3 * a, 1.0 - 0.869 * 0.3 * a);
                vec![
                    format!("rgbashift=rh={s}:bh={}:edge=smear", -s),
                    "lutrgb=r='clip(val*0.95+16,0,255)':g='clip(val*0.95+16,0,255)':b='clip(val*0.95+16,0,255)'".to_string(),
                    format!("colorchannelmixer=rr={rr}:rg={rg}:rb={rb}:gr={gr}:gg={gg}:gb={gb}:br={br}:bg={bg}:bb={bb}"),
                    saturation_matrix(1.0 - 0.35 * a),
                    format!("noise=alls={}:allf=t+u", (a * 16.0).round() as i32),
                    format!("geq=r='r(X,Y)*{f}':g='g(X,Y)*{f}':b='b(X,Y)*{f}'"),
                ]
            }
            _ => continue,
        };
        parts.extend(frags.into_iter().map(|f| with_enable(e, f)));
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
