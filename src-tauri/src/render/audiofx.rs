//! Audio effect filters — same canonical `Effect` model as video fx
//! (params = f64 map, enabled flag, ordered stack). Maps to ffmpeg audio
//! filters; unknown/disabled entries skipped. ADR-026.

use crate::project::document::Effect;

/// One effect → ffmpeg filter fragment (without leading comma), or None.
fn fx_filter(e: &Effect) -> Option<String> {
    if !e.enabled {
        return None;
    }
    let p = |k: &str, d: f64| e.params.get(k).copied().unwrap_or(d);
    Some(match e.kind.as_str() {
        "highpass" => format!("highpass=f={:.0}", p("freq", 80.0).clamp(10.0, 20000.0)),
        "lowpass" => format!("lowpass=f={:.0}", p("freq", 12000.0).clamp(100.0, 20000.0)),
        // 3-band peaking EQ — gains in dB.
        "eq" => format!(
            "equalizer=f=200:t=h:w=100:g={:.1},equalizer=f=1000:t=h:w=500:g={:.1},equalizer=f=8000:t=h:w=2000:g={:.1}",
            p("low", 0.0).clamp(-24.0, 24.0),
            p("mid", 0.0).clamp(-24.0, 24.0),
            p("high", 0.0).clamp(-24.0, 24.0)
        ),
        "denoise" => format!("afftdn=nr={:.0}", p("strength", 12.0).clamp(1.0, 97.0)),
        "compressor" => format!(
            "acompressor=threshold={:.4}:ratio={:.1}:attack={:.1}:release={:.1}:makeup={:.2}",
            (10f64).powf(p("thresholdDb", -18.0) / 20.0).clamp(0.0009, 1.0),
            p("ratio", 3.0).clamp(1.0, 20.0),
            p("attackMs", 20.0).clamp(0.01, 2000.0),
            p("releaseMs", 250.0).clamp(0.01, 9000.0),
            (10f64).powf(p("makeupDb", 0.0) / 20.0).clamp(0.015, 64.0),
        ),
        // Ceiling limiter — level in dBFS (default -0.45 dBTP).
        "limiter" => format!(
            "alimiter=limit={:.4}:level=false",
            (10f64).powf(p("levelDb", -0.45) / 20.0).clamp(0.05, 1.0)
        ),
        "deesser" => format!("deesser=i={:.2}", p("amount", 0.5).clamp(0.0, 1.0)),
        "noisegate" => format!(
            "agate=threshold={:.4}:attack={:.1}:release={:.1}",
            (10f64).powf(p("thresholdDb", -45.0) / 20.0).clamp(0.000_09, 1.0),
            p("attackMs", 10.0).clamp(0.01, 9000.0),
            p("releaseMs", 100.0).clamp(0.01, 9000.0),
        ),
        _ => return None,
    })
}

/// Ordered audio fx chain (comma-prefixed or empty).
pub fn audio_effects_chain(effects: &[Effect]) -> String {
    effects
        .iter()
        .filter_map(|e| fx_filter(e).map(|f| format!(",{f}")))
        .collect()
}

/// Stereo-balance pan: −1 left … +1 right. Emits `pan` remap preserving
/// both channels (balance, not rotate). None when centered.
pub fn pan_filter(pan: f32) -> Option<String> {
    let p = pan.clamp(-1.0, 1.0);
    if p.abs() < 1e-3 {
        return None;
    }
    let gl = (1.0 - p.max(0.0)) as f64;
    let gr = (1.0 - (-p).max(0.0)) as f64;
    Some(format!(
        "aformat=channel_layouts=stereo,pan=stereo|c0={gl:.4}*c0|c1={gr:.4}*c1"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn fx(ty: &str, params: &[(&str, f64)]) -> Effect {
        Effect {
            id: "x".into(),
            kind: ty.into(),
            enabled: true,
            in_ms: None,
            out_ms: None,
            file: None,
            times: None,
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    #[test]
    fn pan_left_attenuates_right() {
        let f = pan_filter(-1.0).unwrap();
        assert!(
            f.contains("c0=1.0000*c0") && f.contains("c1=0.0000*c1"),
            "{f}"
        );
        assert!(pan_filter(0.0).is_none());
    }

    #[test]
    fn audio_chain_maps_filters() {
        let chain = audio_effects_chain(&[
            fx("highpass", &[("freq", 100.0)]),
            fx("denoise", &[("strength", 15.0)]),
            fx("brightness", &[]), // video fx → ignored
        ]);
        assert!(chain.contains("highpass=f=100"));
        assert!(chain.contains("afftdn=nr=15"));
        assert!(!chain.contains("brightness"));
    }
}
