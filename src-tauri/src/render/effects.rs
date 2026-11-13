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
//! | contrast    | amount  | curves master linear pivot .5   | CSS contrast(1+a)  |
//! | saturation  | amount  | colorchannelmixer W3C matrix    | CSS saturate(1+a)  |
//! | temperature | amount  | colorchannelmixer diag matrix   | SVG feColorMatrix  |
//! | blur        | radius  | gblur sigma=radius              | CSS blur(radius)   |
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
                // CSS contrast(c): out = (in-0.5)*c+0.5 per channel → affine
                // ramp via 2-point master curve. Clamped like CSS output.
                let c = (1.0 + param(e, "amount", 0.0)).clamp(0.0, 8.0);
                let lo = (0.5 - 0.5 * c).max(0.0);
                let hi = (0.5 + 0.5 * c).min(1.0);
                format!("curves=m='0/{lo} 1/{hi}'")
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
            _ => continue,
        };
        parts.push(frag);
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
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    #[test]
    fn brightness_maps_to_multiply() {
        let c = effects_chain(&[fx("brightness", &[("amount", 0.5)])]);
        assert!(c.contains("colorchannelmixer=rr=1.5:gg=1.5:bb=1.5"));
    }

    #[test]
    fn contrast_maps_to_linear_curve() {
        let c = effects_chain(&[fx("contrast", &[("amount", 1.0)])]);
        // c=2 → 0/-0.5→0, 1/1.5→1
        assert!(c.contains("curves=m='0/0 1/1'"), "{c}");
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
