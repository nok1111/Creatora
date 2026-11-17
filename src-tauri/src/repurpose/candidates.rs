//! Clip candidate engine: pick self-contained, engaging windows out of a long
//! transcript.
//!
//! Deterministic and local — nothing here predicts virality. Every score
//! component is a plain, explainable heuristic (pace, silence, audio energy,
//! hook, length fit) and each candidate reports which ones it earned.

use crate::project::document::SubtitleCue;
use serde::{Deserialize, Serialize};

/// A pause longer than this is a topic break — a clip never spans it.
const MAX_INNER_GAP_MS: i64 = 3_000;
/// A pause longer than this also counts as a sentence boundary on its own.
const SENTENCE_GAP_MS: i64 = 1_200;
/// Breathing room kept around the spoken part of a clip.
const PAD_START_MS: i64 = 120;
const PAD_END_MS: i64 = 250;
/// Minimum separation between two picked clips.
const MIN_SEPARATION_MS: i64 = 1_000;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub min_ms: i64,
    pub ideal_ms: i64,
    pub max_ms: i64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub rank: usize,
    pub start_ms: i64,
    pub end_ms: i64,
    /// 0–100, relative to this source only.
    pub score: f64,
    pub title: String,
    pub text: String,
    /// Stable codes the UI translates: complete_sentences, good_pace,
    /// tight_cuts, high_energy, strong_hook, ideal_length.
    pub reasons: Vec<&'static str>,
}

/// Normalised audio energy (0..1) per fixed-size bucket.
#[derive(Debug, Clone, Copy)]
pub struct Energy<'a> {
    pub bucket_ms: i64,
    pub values: &'a [f32],
}

fn ends_sentence(text: &str) -> bool {
    let t = text.trim_end_matches(|c: char| matches!(c, '"' | '\'' | ')' | ']' | '”' | '’' | ' '));
    t.ends_with(['.', '!', '?', '…', '。', '！', '？'])
}

fn word_count(c: &SubtitleCue) -> usize {
    if c.words.is_empty() {
        c.text.split_whitespace().count()
    } else {
        c.words.len()
    }
}

const HOOK_WORDS: &[&str] = &[
    "how", "why", "what", "never", "secret", "mistake", "stop", "truth", "tip", "trick", "best",
    "worst", "biggest", "nobody", "everyone", "cómo", "como", "por qué", "porque", "qué", "nunca",
    "secreto", "error", "verdad", "consejo", "truco", "mejor", "peor", "nadie", "todos",
];

fn hook_score(first_text: &str) -> f64 {
    let lower = first_text.to_lowercase();
    let mut s = 0.0;
    if lower.contains('?') {
        s += 0.6;
    }
    let lead: String = lower
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    if HOOK_WORDS.iter().any(|w| lead.contains(w)) {
        s += 0.4;
    } else if HOOK_WORDS.iter().any(|w| lower.contains(w)) {
        s += 0.2;
    }
    if lower.chars().any(|c| c.is_ascii_digit()) {
        s += 0.3;
    }
    f64::min(s, 1.0)
}

fn first_sentence(text: &str) -> String {
    let t = text.trim();
    let end = t
        .char_indices()
        .find(|(_, c)| matches!(c, '.' | '!' | '?' | '…'))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(t.len());
    let s = t[..end].trim();
    if s.chars().count() <= 70 {
        return s.to_string();
    }
    let cut: String = s.chars().take(70).collect();
    let cut = cut.rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut);
    format!("{}…", cut.trim_end_matches(|c: char| !c.is_alphanumeric()))
}

fn mean_energy(e: &Energy, start_ms: i64, end_ms: i64) -> Option<f64> {
    if e.values.is_empty() || e.bucket_ms <= 0 {
        return None;
    }
    let a = (start_ms / e.bucket_ms).max(0) as usize;
    let b = ((end_ms / e.bucket_ms) as usize + 1).min(e.values.len());
    if a >= b {
        return None;
    }
    let s: f64 = e.values[a..b].iter().map(|v| *v as f64).sum();
    Some(s / (b - a) as f64)
}

struct Scored {
    start_ms: i64,
    end_ms: i64,
    score: f64,
    i: usize,
    j: usize,
    reasons: Vec<&'static str>,
}

/// Pick up to `params.count` non-overlapping candidates, best first.
pub fn pick_candidates(
    cues: &[SubtitleCue],
    energy: Option<Energy>,
    params: Params,
) -> Vec<Candidate> {
    let n = cues.len();
    if n == 0 || params.count == 0 {
        return Vec::new();
    }
    let starts_sentence = |i: usize| {
        i == 0
            || ends_sentence(&cues[i - 1].text)
            || cues[i].start_ms - cues[i - 1].end_ms > SENTENCE_GAP_MS
    };

    let mut windows: Vec<Scored> = Vec::new();
    for i in 0..n {
        if !starts_sentence(i) {
            continue;
        }
        for j in i..n {
            if j > i && cues[j].start_ms - cues[j - 1].end_ms > MAX_INNER_GAP_MS {
                break;
            }
            let dur = cues[j].end_ms - cues[i].start_ms;
            if dur > params.max_ms {
                break;
            }
            let closes = ends_sentence(&cues[j].text)
                || j + 1 == n
                || cues[j + 1].start_ms - cues[j].end_ms > SENTENCE_GAP_MS;
            if dur < params.min_ms || !closes {
                continue;
            }
            windows.push(score_window(cues, i, j, energy, params));
        }
    }

    windows.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.start_ms.cmp(&b.start_ms))
    });

    let mut picked: Vec<Scored> = Vec::new();
    for w in windows {
        if picked.len() >= params.count {
            break;
        }
        let clash = picked.iter().any(|p| {
            w.start_ms < p.end_ms + MIN_SEPARATION_MS && p.start_ms < w.end_ms + MIN_SEPARATION_MS
        });
        if !clash {
            picked.push(w);
        }
    }

    picked
        .into_iter()
        .enumerate()
        .map(|(k, w)| {
            let text = cues[w.i..=w.j]
                .iter()
                .map(|c| c.text.trim())
                .collect::<Vec<_>>()
                .join(" ");
            Candidate {
                id: format!("cand-{}", k + 1),
                rank: k + 1,
                start_ms: w.start_ms,
                end_ms: w.end_ms,
                score: (w.score * 100.0 * 10.0).round() / 10.0,
                title: first_sentence(&text),
                text,
                reasons: w.reasons,
            }
        })
        .collect()
}

fn score_window(
    cues: &[SubtitleCue],
    i: usize,
    j: usize,
    energy: Option<Energy>,
    p: Params,
) -> Scored {
    let start = cues[i].start_ms;
    let end = cues[j].end_ms;
    let dur_ms = (end - start).max(1);
    let dur_s = dur_ms as f64 / 1000.0;

    let words: usize = cues[i..=j].iter().map(word_count).sum();
    let wps = words as f64 / dur_s;
    let density = if wps < 2.0 {
        wps / 2.0
    } else if wps <= 3.6 {
        1.0
    } else {
        (1.0 - (wps - 3.6) / 2.0).max(0.0)
    };

    let gaps: i64 = cues[i..=j]
        .windows(2)
        .map(|w| (w[1].start_ms - w[0].end_ms).max(0))
        .sum();
    let silence = 1.0 - ((gaps as f64 / dur_ms as f64) / 0.35).min(1.0);

    let energy_s = energy
        .as_ref()
        .and_then(|e| mean_energy(e, start, end))
        .map(|m| (m / 0.55).min(1.0));

    let first_text: String = cues[i..=j]
        .iter()
        .take_while(|c| c.start_ms - start < 7_000)
        .map(|c| c.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let hook = hook_score(&first_text);

    let half_range = ((p.max_ms - p.min_ms) as f64 / 2.0).max(1.0);
    let len_fit = (1.0 - ((dur_ms - p.ideal_ms).abs() as f64 / half_range)).clamp(0.0, 1.0);

    // Weights sum to 1; when no audio energy is available its share is
    // redistributed proportionally.
    let (w_d, w_s, w_e, w_h, w_l) = (0.22, 0.16, 0.22, 0.25, 0.15);
    let mut total = w_d * density + w_s * silence + w_h * hook + w_l * len_fit;
    let mut weight = w_d + w_s + w_h + w_l;
    if let Some(e) = energy_s {
        total += w_e * e;
        weight += w_e;
    }
    let score = total / weight;

    let mut reasons = vec!["complete_sentences"];
    if density >= 0.85 {
        reasons.push("good_pace");
    }
    if silence >= 0.85 {
        reasons.push("tight_cuts");
    }
    if energy_s.is_some_and(|e| e >= 0.8) {
        reasons.push("high_energy");
    }
    if hook >= 0.5 {
        reasons.push("strong_hook");
    }
    if len_fit >= 0.8 {
        reasons.push("ideal_length");
    }

    Scored {
        start_ms: (start - PAD_START_MS).max(0),
        end_ms: end + PAD_END_MS,
        score,
        i,
        j,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(i: usize, start_s: f64, end_s: f64, text: &str) -> SubtitleCue {
        SubtitleCue {
            id: format!("c{i}"),
            start_ms: (start_s * 1000.0) as i64,
            end_ms: (end_s * 1000.0) as i64,
            text: text.into(),
            style_id: None,
            words: vec![],
        }
    }

    /// `n` back-to-back 5 s sentences of ~12 words (a natural pace).
    fn speech(n: usize, t0: f64, first: &str) -> Vec<SubtitleCue> {
        (0..n)
            .map(|k| {
                let text = if k == 0 {
                    first.to_string()
                } else {
                    format!("this is plain sentence number {k} about the same topic really.")
                };
                cue(k, t0 + k as f64 * 5.0, t0 + k as f64 * 5.0 + 4.9, &text)
            })
            .collect()
    }

    const P: Params = Params {
        min_ms: 20_000,
        ideal_ms: 30_000,
        max_ms: 45_000,
        count: 3,
    };

    #[test]
    fn windows_are_sentence_aligned_and_within_bounds() {
        let cues = speech(30, 0.0, "Alright here we go with the first point today.");
        let out = pick_candidates(&cues, None, P);
        assert!(!out.is_empty());
        for c in &out {
            let dur = c.end_ms - c.start_ms;
            assert!(
                dur >= P.min_ms && dur <= P.max_ms + PAD_START_MS + PAD_END_MS,
                "{dur}"
            );
            assert!(c.text.trim_end().ends_with('.'));
            assert!(c.reasons.contains(&"complete_sentences"));
        }
    }

    #[test]
    fn picks_are_non_overlapping_and_capped() {
        let cues = speech(60, 0.0, "Alright here we go with the first point today.");
        let out = pick_candidates(&cues, None, P);
        assert!(out.len() <= P.count && out.len() >= 2);
        let mut sorted: Vec<_> = out.iter().collect();
        sorted.sort_by_key(|c| c.start_ms);
        for w in sorted.windows(2) {
            assert!(w[1].start_ms >= w[0].end_ms + MIN_SEPARATION_MS - 1);
        }
        assert_eq!(
            out.iter().map(|c| c.rank).collect::<Vec<_>>(),
            (1..=out.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_question_hook_wins_over_an_identical_flat_region() {
        let mut cues = speech(8, 0.0, "Alright here we go with the first point today.");
        // 60 s later (topic break), same shape but opening with a hook.
        cues.extend(speech(
            8,
            100.0,
            "Why does nobody talk about the 3 biggest mistakes?",
        ));
        let out = pick_candidates(&cues, None, Params { count: 1, ..P });
        assert_eq!(out.len(), 1);
        assert!(out[0].start_ms >= 99_000, "start {}", out[0].start_ms);
        assert!(out[0].reasons.contains(&"strong_hook"));
        assert!(out[0].title.starts_with("Why does nobody"));
    }

    #[test]
    fn never_spans_a_long_silence() {
        let mut cues = speech(5, 0.0, "Alright here we go with the first point today.");
        cues.extend(speech(
            5,
            31.0,
            "Alright here we go with the second point today.",
        ));
        // 25 s of speech, then a 6 s hole, then 25 s more: only a window that
        // crosses the hole could reach the 45 s max — it must not exist.
        let out = pick_candidates(
            &cues,
            None,
            Params {
                min_ms: 40_000,
                ideal_ms: 45_000,
                max_ms: 56_000,
                count: 5,
            },
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn audio_energy_breaks_ties() {
        let mut cues = speech(8, 0.0, "Alright here we go with the first point today.");
        cues.extend(speech(
            8,
            100.0,
            "Alright here we go with the second point today.",
        ));
        // 1 s buckets: quiet first region, loud second.
        let values: Vec<f32> = (0..145).map(|s| if s < 60 { 0.1 } else { 0.9 }).collect();
        let e = Energy {
            bucket_ms: 1000,
            values: &values,
        };
        let out = pick_candidates(&cues, Some(e), Params { count: 1, ..P });
        assert!(out[0].start_ms >= 99_000);
        assert!(out[0].reasons.contains(&"high_energy"));
    }

    #[test]
    fn empty_or_too_short_input_yields_nothing() {
        assert!(pick_candidates(&[], None, P).is_empty());
        let short = speech(2, 0.0, "Only ten seconds of talk in total here.");
        assert!(pick_candidates(&short, None, P).is_empty());
        assert!(pick_candidates(&speech(30, 0.0, "x."), None, Params { count: 0, ..P }).is_empty());
    }

    #[test]
    fn titles_are_trimmed_to_a_word_boundary() {
        let long = "word ".repeat(30);
        let t = first_sentence(&long);
        assert!(t.chars().count() <= 71 && t.ends_with('…'), "{t}");
        assert_eq!(first_sentence("Short one. And more."), "Short one.");
    }
}
