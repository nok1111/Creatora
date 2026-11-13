//! Text-track rendering — ffmpeg `drawtext` for text clips.
//!
//! Canonical model: `TextStyle` (project/document.rs) is consumed here and
//! by the DOM preview (`Preview.tsx`) — v1 covers exactly what BOTH can
//! express: font size/color, outline, box background, alignment, plus
//! clip transform offset/opacity and keyframes on x/y/opacity.
//!
//! Rendering: each text clip emits a transparent `color` source inside
//! filter_complex (no file input), `drawtext` for glyphs, then the usual
//! gated overlay. Escape rules target the drawtext option level.

use crate::project::document::{Keyframe, TextStyle};
use crate::render::keyframes as kf;

/// "#RRGGBB" → `0xRRGGBB`; "#RRGGBBAA" → `0xRRGGBB@0.AA` (alpha as fraction).
pub fn color(c: &str) -> String {
    let h = c.trim_start_matches('#');
    if h.len() == 8 {
        let a = u8::from_str_radix(&h[6..8], 16).unwrap_or(255) as f64 / 255.0;
        format!("0x{}@{a:.3}", &h[..6])
    } else {
        format!("0x{}", &h[..6.min(h.len())])
    }
}

/// Escape `s` for use as drawtext `text='…'` content inside filter_complex.
/// Order matters: backslash first.
fn esc_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            ':' => out.push_str("\\:"),
            ',' => out.push_str("\\,"),
            ';' => out.push_str("\\;"),
            '[' => out.push_str("\\["),
            ']' => out.push_str("\\]"),
            '=' => out.push_str("\\="),
            '%' => out.push_str("%%"),
            _ => out.push(ch),
        }
    }
    out
}

/// Escape a filesystem path for `fontfile='…'` (forward slashes, escaped ':').
fn esc_path(p: &str) -> String {
    p.replace('\\', "/").replace(':', "\\:")
}

/// Default font when no `fontFile` is set. Windows desktop app → arial.
const DEFAULT_FONT: &str = "C:/Windows/Fonts/arial.ttf";
/// Second-line fallback when arial is absent (Win10/11 always ships Segoe UI).
const FALLBACK_FONT: &str = "C:/Windows/Fonts/segoeui.ttf";

/// Resolve the font file for this style: configured → arial → segoe → None.
/// A missing configured font falls back instead of killing the render.
/// None = omit `fontfile` (drawtext then uses its own default lookup).
pub fn resolve_font(style: &TextStyle) -> Option<String> {
    let exists = |p: &str| std::path::Path::new(p).is_file();
    if let Some(f) = style.font_file.as_deref().filter(|f| !f.is_empty()) {
        if exists(f) {
            return Some(f.to_string());
        }
    }
    for cand in [DEFAULT_FONT, FALLBACK_FONT] {
        if exists(cand) {
            return Some(cand.to_string());
        }
    }
    None
}

/// The `drawtext` option string for a styled text clip.
/// `x`/`y` expressions may be animated via keyframes on transform.x/y.
pub fn drawtext_opts(style: &TextStyle, text: &str, x_expr: &str, y_expr: &str) -> String {
    let font_opts = resolve_font(style)
        .map(|f| format!(":fontfile='{}'", esc_path(&f)))
        .unwrap_or_default();
    let mut o = format!(
        "drawtext=text='{}':fontsize={}:fontcolor={}{}",
        esc_text(text),
        style.font_size_px.max(1.0),
        color(&style.color),
        font_opts,
    );
    if let Some(oc) = &style.outline_color {
        if style.outline_width > 0.0 {
            o.push_str(&format!(
                ":borderw={}:bordercolor={}",
                style.outline_width,
                color(oc)
            ));
        }
    }
    if let Some(bg) = &style.background_color {
        o.push_str(&format!(
            ":box=1:boxcolor={}:boxborderw={}",
            color(bg),
            style.background_pad_px.max(0.0)
        ));
    }
    if let Some(sc) = &style.shadow_color {
        o.push_str(&format!(
            ":shadowcolor={}:shadowx={}:shadowy={}",
            color(sc),
            style.shadow_x,
            style.shadow_y,
        ));
    }
    if style.line_spacing_px != 0.0 {
        o.push_str(&format!(":line_spacing={}", style.line_spacing_px));
    }
    o.push_str(&format!(":x='{x_expr}':y='{y_expr}'"));
    o
}

/// Alignment expressions — same anchor model as the preview's flexbox:
/// the text block is positioned on the canvas, transform.x/y offset.
pub fn anchor_exprs(style: &TextStyle, tx: &str, ty: &str) -> (String, String) {
    let x = match style.align_h.as_str() {
        "left" => format!("({tx})"),
        "right" => format!("w-text_w+({tx})"),
        _ => format!("(w-text_w)/2+({tx})"),
    };
    let y = match style.align_v.as_str() {
        "top" => format!("({ty})"),
        "bottom" => format!("h-text_h+({ty})"),
        _ => format!("(h-text_h)/2+({ty})"),
    };
    (x, y)
}

/// Keyframed or static expressions for transform.x/y in a drawtext chain —
/// clip-relative `t` (the generated source's own PTS starts at 0).
pub fn pos_exprs_at(
    kfs: &std::collections::BTreeMap<String, Vec<Keyframe>>,
    tx: f64,
    ty: f64,
    clip_start_s: f64,
) -> (String, String) {
    let x = kfs
        .get("transform.x")
        .map(|k| kf::expr(k, clip_start_s, tx))
        .unwrap_or_else(|| format!("{tx}"));
    let y = kfs
        .get("transform.y")
        .map(|k| kf::expr(k, clip_start_s, ty))
        .unwrap_or_else(|| format!("{ty}"));
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_break_filter_syntax() {
        let e = esc_text("a:b,c;d[e]=f%g'h\\i");
        assert_eq!(e, "a\\:b\\,c\\;d\\[e\\]\\=f%%g\\'h\\\\i");
    }

    #[test]
    fn color_alpha_variant() {
        assert_eq!(color("#FF0000"), "0xFF0000");
        assert_eq!(color("#FF000080"), "0xFF0000@0.502");
    }

    #[test]
    fn shadow_and_spacing_emit_drawtext_opts() {
        let st = TextStyle {
            shadow_color: Some("#000000CC".into()),
            shadow_x: 3.0,
            shadow_y: -2.0,
            line_spacing_px: 12.0,
            ..Default::default()
        };
        let o = drawtext_opts(&st, "hi", "0", "0");
        assert!(o.contains("shadowcolor=0x000000@0.8"), "{o}");
        assert!(o.contains(":shadowx=3:shadowy=-2"), "{o}");
        assert!(o.contains(":line_spacing=12"), "{o}");
    }

    #[test]
    fn missing_font_falls_back_instead_of_failing() {
        // Configured font that doesn't exist → falls back to a platform
        // candidate (or omits fontfile) — never returns the broken path.
        let st = TextStyle {
            font_file: Some("C:/nonexistent/dead_font.ttf".into()),
            ..Default::default()
        };
        let f = resolve_font(&st);
        if let Some(f) = &f {
            assert!(std::path::Path::new(f).is_file(), "{f}");
        }
        let o = drawtext_opts(&st, "hi", "0", "0");
        assert!(!o.contains("dead_font"), "{o}");
    }

    #[test]
    fn anchors() {
        let s = TextStyle {
            align_h: "right".into(),
            align_v: "bottom".into(),
            ..Default::default()
        };
        let (x, y) = anchor_exprs(&s, "10", "20");
        assert_eq!(x, "w-text_w+(10)");
        assert_eq!(y, "h-text_h+(20)");
    }
}
