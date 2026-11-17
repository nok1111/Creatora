//! Subtitle model → ASS/SRT/VTT serialization + whisper.cpp integration.
//!
//! Cues live in `doc.subtitles` (timeline ms). Burn-in renders ASS through
//! the libass `subtitles` filter — handles wrapping, outline, box, margins
//! and `\k` karaoke word timing that drawtext cannot (ADR-025).

pub mod commands;

use crate::project::document::{NamedSubtitleStyle, ProjectDoc, SubtitleCue, SubtitleStyle};

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

/// One `Style:` line for the [V4+ Styles] section — used for the master
/// style and for every named style a cue references.
fn ass_style_line(name: &str, ss: &SubtitleStyle) -> String {
    let st = &ss.text;
    let font = st
        .font_file
        .as_deref()
        .and_then(|p| p.rsplit(['/', '\\']).next())
        .and_then(|n| n.rsplit_once('.'))
        .map(|(n, _)| n)
        .or(st.font_name.as_deref())
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
    format!(
        "Style: {name},{font},{},{},{},{outline},{back},-1,0,0,0,100,100,0,0,{border},{},0,{align},{},{},{},1",
        st.font_size_px,
        ass_color(&st.color),
        ass_color(&ss.highlight_color),
        st.outline_width.max(0.0),
        ss.margin_h_px as i64,
        ss.margin_h_px as i64,
        ss.margin_v_px as i64,
    )
}

/// ASS document for the cues with a style — `PlayResX/Y` = canvas so margin
/// values are canvas px, matching the preview's coordinate space. Cues with
/// `style_id` get their own Style entry; their mode may differ per cue.
pub fn to_ass(doc: &ProjectDoc, cues: &[SubtitleCue], style: &SubtitleStyle) -> String {
    // Distinct named styles actually referenced → extra Style lines.
    let mut named: Vec<&NamedSubtitleStyle> = Vec::new();
    let mut style_lines = vec![ass_style_line("Sub", style)];
    for cue in cues {
        if let Some(id) = cue.style_id.as_deref() {
            if let Some(ns) = doc.subtitle_styles.iter().find(|s| s.id == id) {
                if !named.iter().any(|n| n.id == ns.id) {
                    style_lines.push(ass_style_line(&format!("Sub{}", named.len()), &ns.style));
                    named.push(ns);
                }
            }
        }
    }
    let mut out = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n{}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        doc.canvas.width,
        doc.canvas.height,
        style_lines.join("\n"),
    );
    for cue in cues {
        let (ss, sname) = match cue.style_id.as_deref().and_then(|id| {
            named
                .iter()
                .position(|n| n.id == id)
                .map(|i| (&named[i].style, format!("Sub{i}")))
        }) {
            Some(t) => t,
            None => (style, "Sub".to_string()),
        };
        let start = ass_time(cue.start_ms);
        let end = ass_time(cue.end_ms);
        match ss.mode.as_str() {
            "karaoke" | "jump" if !cue.words.is_empty() => {
                // Karaoke fill per word; "jump" adds a per-syllable scale
                // bounce (renderers ignoring syllable \t still get the fill).
                let mut t = String::new();
                for w in &cue.words {
                    let dur_cs = ((w.end_ms - w.start_ms) / 10).max(1);
                    if ss.mode == "jump" {
                        t.push_str(&format!(
                            "{{\\kf{dur_cs}\\t(0,120,\\fscx130\\fscy130)\\t(120,300,\\fscx100\\fscy100)}}{}",
                            esc_ass(&w.word)
                        ));
                    } else {
                        t.push_str(&format!("{{\\k{dur_cs}}}{}", esc_ass(&w.word)));
                    }
                }
                out.push_str(&format!("Dialogue: 0,{start},{end},{sname},,0,0,0,,{t}\n"));
            }
            "impact" if !cue.words.is_empty() => {
                // Word-by-word: one Dialogue per word that slams down from
                // 160% over ~250ms as it appears.
                for w in &cue.words {
                    out.push_str(&format!(
                        "Dialogue: 0,{},{},{sname},,0,0,0,,{{\\fscx160\\fscy160\\t(0,250,\\fscx100\\fscy100)}}{}\n",
                        ass_time(w.start_ms),
                        ass_time(w.end_ms),
                        esc_ass(w.word.trim())
                    ));
                }
            }
            "pop" if !cue.words.is_empty() => {
                // One Dialogue per word — only the active word is visible.
                for w in &cue.words {
                    out.push_str(&format!(
                        "Dialogue: 0,{},{},{sname},,0,0,0,,{}\n",
                        ass_time(w.start_ms),
                        ass_time(w.end_ms),
                        esc_ass(w.word.trim())
                    ));
                }
            }
            "impact" => {
                // No word timing — slam the whole cue in.
                out.push_str(&format!(
                    "Dialogue: 0,{start},{end},{sname},,0,0,0,,{{\\fscx145\\fscy145\\t(0,250,\\fscx100\\fscy100)}}{}\n",
                    esc_ass(&cue.text)
                ));
            }
            _ => {
                out.push_str(&format!(
                    "Dialogue: 0,{start},{end},{sname},,0,0,0,,{}\n",
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

    #[test]
    fn ass_jump_scales_per_word() {
        let d = doc_with_cues();
        let st = SubtitleStyle {
            mode: "jump".into(),
            ..Default::default()
        };
        let a = to_ass(&d, &d.subtitles, &st);
        assert!(a.contains("{\\kf80"));
        assert!(a.contains("\\fscx130\\fscy130"));
        assert!(a.matches("Dialogue:").count() == 1);
    }

    #[test]
    fn ass_impact_emits_per_word_slam() {
        let d = doc_with_cues();
        let st = SubtitleStyle {
            mode: "impact".into(),
            ..Default::default()
        };
        let a = to_ass(&d, &d.subtitles, &st);
        assert!(a.matches("Dialogue:").count() == 2);
        assert!(a.contains("\\fscx160\\fscy160"));
        assert!(a.contains("\\t(0,250,\\fscx100\\fscy100)"));
    }

    #[test]
    fn ass_impact_without_words_slams_cue() {
        let mut d = doc_with_cues();
        d.subtitles[0].words.clear();
        let st = SubtitleStyle {
            mode: "impact".into(),
            ..Default::default()
        };
        let a = to_ass(&d, &d.subtitles, &st);
        assert!(a.contains("\\fscx145\\fscy145"));
        assert!(a.contains("Hello, !"));
    }

    #[test]
    fn ass_per_cue_style_emits_named_style() {
        let mut d = doc_with_cues();
        d.subtitle_styles.push(NamedSubtitleStyle {
            id: "s1".into(),
            name: "Neon".into(),
            style: SubtitleStyle {
                mode: "jump".into(),
                ..Default::default()
            },
        });
        d.subtitles[0].style_id = Some("s1".into());
        let a = to_ass(&d, &d.subtitles, &d.subtitle_style.clone());
        assert!(a.matches("Style: Sub").count() == 2);
        assert!(a.contains(",Sub0,"));
        assert!(a.contains("{\\kf80"));
    }
}
