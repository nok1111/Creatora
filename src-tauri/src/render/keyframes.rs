//! Keyframe evaluation → ffmpeg expressions.
//!
//! A keyframed property becomes a piecewise-linear expression in `t`
//! (seconds). The SAME interpolation runs in the preview
//! (`src/lib/effects.ts` → `evalKeyframes`), so preview and render agree
//! within float rounding.
//!
//! v1 supports linear interpolation only; ease values other than "linear"
//! fall back to linear (documented, forward-compatible field).

use crate::project::document::Keyframe;

/// Eval a keyframed property at clip-relative `t_ms`. Missing/empty → `base`.
/// Clamps outside the sample range to the nearest keyframe value.
pub fn eval_at(kfs: &[Keyframe], t_ms: i64, base: f64) -> f64 {
    if kfs.is_empty() {
        return base;
    }
    let mut ks: Vec<&Keyframe> = kfs.iter().collect();
    ks.sort_by_key(|k| k.t_ms);
    if t_ms <= ks[0].t_ms {
        return ks[0].v;
    }
    if t_ms >= ks[ks.len() - 1].t_ms {
        return ks[ks.len() - 1].v;
    }
    for w in ks.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t_ms >= a.t_ms && t_ms <= b.t_ms {
            let span = (b.t_ms - a.t_ms) as f64;
            if span <= 0.0 {
                return b.v;
            }
            let u = (t_ms - a.t_ms) as f64 / span;
            return a.v + (b.v - a.v) * u;
        }
    }
    base
}

/// Nested-if ffmpeg expression in seconds (`t` must be in scope).
/// `t` here is **clip-relative seconds** — callers pass the clip's own
/// timeline via the chain's reset PTS.
///
/// Output shape for samples [(t0,v0),(t1,v1),…]:
///   if(lt(t,t1), v0+(v1-v0)*(t-t0)/(t1-t0), …final_v)
/// wrapped by clamp: before t0 → v0, after last → vlast.
pub fn expr(kfs: &[Keyframe], clip_start_s: f64, base: f64) -> String {
    expr_var(kfs, clip_start_s, base, "t")
}

/// Same as [`expr`] but uses `var` as the time variable. Needed because
/// geq exposes `T` (uppercase), overlay/rotate/volume use `t`, and
/// zoompan uses `time`.
pub fn expr_var(kfs: &[Keyframe], clip_start_s: f64, base: f64, var: &str) -> String {
    if kfs.is_empty() {
        return format!("{base}");
    }
    let mut ks: Vec<&Keyframe> = kfs.iter().collect();
    ks.sort_by_key(|k| k.t_ms);
    // Build innermost-out: last segment falls through to its end value.
    let mut e = format!("{}", ks[ks.len() - 1].v);
    for w in ks.windows(2).rev() {
        let (a, b) = (w[0], w[1]);
        let (ta, tb) = (
            clip_start_s + a.t_ms as f64 / 1000.0,
            clip_start_s + b.t_ms as f64 / 1000.0,
        );
        let seg = if tb - ta > 0.0 {
            format!("{}+({}-{})*({}-{})/({})", a.v, b.v, a.v, var, ta, tb - ta)
        } else {
            format!("{}", b.v)
        };
        e = format!("if(lt({var},{tb}),{seg},{e})");
    }
    let t0 = clip_start_s + ks[0].t_ms as f64 / 1000.0;
    format!("if(lt({var},{t0}),{},{e})", ks[0].v)
}

/// Which property paths the renderer can animate (v1 scope):
/// overlay x/y, transform scale & rotation, opacity, volume.
pub const ANIMATABLE: &[&str] = &[
    "transform.x",
    "transform.y",
    "transform.scaleX",
    "transform.scaleY",
    "transform.rotationDeg",
    "transform.opacity",
    "volume",
];

pub fn is_animatable(path: &str) -> bool {
    ANIMATABLE.contains(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(t_ms: i64, v: f64) -> Keyframe {
        Keyframe {
            t_ms,
            v,
            ease: "linear".into(),
        }
    }

    #[test]
    fn eval_interpolates_linearly() {
        let ks = vec![kf(0, 0.0), kf(1000, 100.0)];
        assert_eq!(eval_at(&ks, 0, 5.0), 0.0);
        assert_eq!(eval_at(&ks, 500, 5.0), 50.0);
        assert_eq!(eval_at(&ks, 1000, 5.0), 100.0);
        assert_eq!(eval_at(&ks, 2000, 5.0), 100.0); // clamped
        assert_eq!(eval_at(&ks, -100, 5.0), 0.0);
    }

    #[test]
    fn eval_empty_returns_base() {
        assert_eq!(eval_at(&[], 500, 3.0), 3.0);
    }

    #[test]
    fn expr_builds_nested_ifs() {
        let ks = vec![kf(0, 0.0), kf(1000, 100.0)];
        let e = expr(&ks, 2.0, 0.0);
        assert!(e.contains("if(lt(t,3"), "{e}");
        assert!(e.contains("(t-2"), "{e}");
    }
}
