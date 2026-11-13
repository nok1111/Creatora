//! Subtitle model → ASS/SRT/VTT serialization + whisper.cpp integration.
//!
//! Cues live in `doc.subtitles` (timeline ms). Burn-in renders ASS through
//! the libass `subtitles` filter — handles wrapping, outline, box, margins
//! and `\k` karaoke word timing that drawtext cannot (ADR-025).

pub mod commands;

use crate::project::document::{ProjectDoc, SubtitleCue, SubtitleStyle};

fn ass_color(c: &str) -> String {
    // "#RRGGBB[AA]" → ASS &H[AABBGGRR]
    let h = c.trim_start_matches('#');
    let (rgb, aa) = if h.len() == 8 {
        (&h[..6], u8::from_str_radix(&h[6..8], 16).unwrap_or(255))
    } else {
        (&h[..6.min(h.len())], 255u8)
    };
    format!(
        "&H{:02X}{}{}{}",
        255 - aa,
        &rgb[4..6],
        &rgb[2..4],
        &rgb[..2]
    )
}

fn ass_time(ms: i64) -> String {
    let ms = ms.max(0);
    format!(
        "{}:{:02}:{:02}.{:02}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        (ms % 1000) / 10
    )
}

fn srt_time(ms: i64) -> String {
    let ms = ms.max(0);
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    )
}

fn vtt_time(ms: i64) -> String {
    srt_time(ms).replace(',', ".")
}

fn esc_ass(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\n', "\\N")
        .replace('{', "\\{")
        .replace('}', "\\}")
}

/// ASS document for the cues with a style — `PlayResX/Y` = canvas so margin
/// values are canvas px, matching the preview's coordinate space.
pub fn to_ass(doc: &ProjectDoc, cues: &[SubtitleCue], style: &SubtitleStyle) -> String {
    let st = &style.text;
    let font = st
        .font_file
        .as_deref()
        .and_then(|p| p.rsplit(['/', '\\']).next())
        .and_then(|n| n.rsplit_once('.'))
        .map(|(n, _)| n)
        .unwrap_or("Arial");
    let outline = ass_color(st.outline_color.as_deref().unwrap_or("#000000"));
    let back = st
        .background_color
        .as_deref()
        .map(ass_color)
        .unwrap_or_else(|| "&H80000000".into());
    let border = if st.background_color.is_some() { 3 } else { 1 }; // box vs outline+shadow
    let align = match (st.align_h.as_str(), st.align_v.as_str()) {
        ("left", "top") => 7,
        ("center", "top") => 8,
        ("right", "top") => 9,
        ("left", "middle") => 4,
        ("right", "middle") => 6,
        ("left", "bottom") => 1,
        ("right", "bottom") => 3,
        (_, "middle") => 5,
        (_, "top") => 8,
        _ => 2, // bottom-center default
    };
    let mut out = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Sub,{font},{},{},{},{outline},{back},-1,0,0,0,100,100,0,0,{border},{},0,{align},{},{},{},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        doc.canvas.width,
        doc.canvas.height,
        st.font_size_px,
        ass_color(&st.color),
        ass_color(&style.highlight_color),
        st.outline_width.max(0.0),
        style.margin_h_px as i64,
        style.margin_h_px as i64,
        style.margin_v_px as i64,
    );
    for cue in cues {
        let start = ass_time(cue.start_ms);
        let end = ass_time(cue.end_ms);
        match style.mode.as_str() {
            "karaoke" if !cue.words.is_empty() => {
                // \k centiseconds per word — real per-word fill.
                let mut t = String::new();
                for w in &cue.words {
                    let dur_cs = ((w.end_ms - w.start_ms) / 10).max(1);
                    t.push_str(&format!("{{\\k{dur_cs}}}{}", esc_ass(&w.word)));
                }
                out.push_str(&format!("Dialogue: 0,{start},{end},Sub,,0,0,0,,{t}\n"));
            }
            "pop" if !cue.words.is_empty() => {
                // One Dialogue per word — only the active word is visible.
                for w in &cue.words {
                    out.push_str(&format!(
                        "Dialogue: 0,{},{},Sub,,0,0,0,,{}\n",
                        ass_time(w.start_ms),
                        ass_time(w.end_ms),
                        esc_ass(w.word.trim())
                    ));
                }
            }
            _ => {
                out.push_str(&format!(
                    "Dialogue: 0,{start},{end},Sub,,0,0,0,,{}\n",
                    esc_ass(&cue.text)
                ));
            }
        }
    }
    out
}

pub fn to_srt(cues: &[SubtitleCue]) -> String {
    let mut out = String::new();
    for (i, cue) in cues.iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            srt_time(cue.start_ms),
            srt_time(cue.end_ms),
            cue.text.trim()
        ));
    }
    out
}

pub fn to_vtt(cues: &[SubtitleCue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for cue in cues {
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            vtt_time(cue.start_ms),
            vtt_time(cue.end_ms),
            cue.text.trim()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::document::*;

    fn doc_with_cues() -> ProjectDoc {
        let mut d = ProjectDoc::new(
            "t",
            Canvas {
                width: 320,
                height: 240,
                fps_num: 30,
                fps_den: 1,
                background: "#000".into(),
            },
        );
        d.subtitles.push(SubtitleCue {
            id: "c1".into(),
            start_ms: 1000,
            end_ms: 3000,
            text: "Hello, !".into(),
            style_id: None,
            words: vec![
                WordTiming {
                    word: "Hello".into(),
                    start_ms: 1000,
                    end_ms: 1800,
                },
                WordTiming {
                    word: " world".into(),
                    start_ms: 1800,
                    end_ms: 2800,
                },
            ],
        });
        d
    }

    #[test]
    fn srt_format() {
        let d = doc_with_cues();
        let s = to_srt(&d.subtitles);
        assert!(s.contains("1\n00:00:01,000 --> 00:00:03,000\nHello, !"));
    }

    #[test]
    fn vtt_format() {
        let d = doc_with_cues();
        let v = to_vtt(&d.subtitles);
        assert!(v.starts_with("WEBVTT"));
        assert!(v.contains("00:00:01.000 --> 00:00:03.000"));
    }

    #[test]
    fn ass_karaoke_emits_k_tags() {
        let d = doc_with_cues();
        let st = SubtitleStyle {
            mode: "karaoke".into(),
            ..Default::default()
        };
        let a = to_ass(&d, &d.subtitles, &st);
        assert!(a.contains("{\\k80}Hello"));
        assert!(a.contains("{\\k100} world"));
        assert!(a.contains("PlayResX: 320"));
    }

    #[test]
    fn ass_pop_emits_per_word_lines() {
        let d = doc_with_cues();
        let st = SubtitleStyle {
            mode: "pop".into(),
            ..Default::default()
        };
        let a = to_ass(&d, &d.subtitles, &st);
        assert!(a.matches("Dialogue:").count() == 2);
    }
}
