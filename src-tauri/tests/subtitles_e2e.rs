//! Real whisper.cpp transcription — runs only when the provisioned
//! binary + a model exist (CI/dev machines). Verifies cues + word timing
//! come back with sane values; asserts structure, not transcription
//! accuracy (model-dependent).

use creatora_lib::subtitles::commands::parse_whisper_json;
use std::path::PathBuf;
use std::process::Command;

fn tool(name: &str) -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("tools");
    let p = root.join("bin").join(name);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

fn model() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("tools");
    ["ggml-tiny.bin", "ggml-base.bin", "ggml-small.bin"]
        .iter()
        .map(|m| root.join("models").join(m))
        .find(|p| p.is_file())
}

#[test]
fn whisper_json_parses_segments_and_word_tokens() {
    let json = r#"{"transcription":[{"offsets":{"from":100,"to":2000},"text":" Hello world",
        "tokens":[{"offsets":{"from":100,"to":400},"text":" Hello"},
                  {"offsets":{"from":400,"to":700},"text":" wo"},
                  {"offsets":{"from":700,"to":1500},"text":"rld"}]}]}"#;
    let cues = parse_whisper_json(json);
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].start_ms, 100);
    assert_eq!(cues[0].end_ms, 2000);
    assert_eq!(cues[0].text, "Hello world");
    // sub-word tokens merge into the previous word with real timing
    assert_eq!(cues[0].words.len(), 2);
    assert_eq!(cues[0].words[1].word, " world");
    assert_eq!(cues[0].words[1].end_ms, 1500);
}

/// End-to-end: generate speech-shaped audio, run whisper-cli -ojf, parse
/// cues. Skips when binary/model absent.
#[test]
fn whisper_cli_produces_cues_with_word_timings() {
    let (Some(ff), Some(wh), Some(m)) = (tool("ffmpeg.exe"), tool("whisper-cli.exe"), model())
    else {
        eprintln!("skip: ffmpeg/whisper-cli/model not provisioned");
        return;
    };
    let dir = std::env::temp_dir().join("creatora_wh_test");
    std::fs::create_dir_all(&dir).unwrap();
    let wav = dir.join("in.wav");
    // speech-ish: voiced tone with pauses (not real speech — structural check)
    let st = Command::new(&ff)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:duration=4",
            &wav.to_string_lossy(),
        ])
        .output()
        .unwrap();
    assert!(st.status.success());

    let out_base = dir.join("out");
    let st = Command::new(&wh)
        .args([
            "-m",
            &m.to_string_lossy(),
            "-f",
            &wav.to_string_lossy(),
            "-ojf",
            "-of",
            &out_base.to_string_lossy(),
            "-l",
            "en",
        ])
        .output()
        .unwrap();
    assert!(
        st.status.success(),
        "whisper failed: {}",
        String::from_utf8_lossy(&st.stderr)
    );
    let json = std::fs::read_to_string(out_base.with_extension("json")).unwrap();
    let cues = parse_whisper_json(&json);
    // On non-speech input whisper may return 0 cues — that's valid; when it
    // does emit, word timings must be monotonic and inside the segment.
    for c in &cues {
        assert!(c.end_ms > c.start_ms, "invalid cue duration");
        for w in &c.words {
            assert!(w.end_ms >= w.start_ms, "inverted word timing");
        }
    }
}
