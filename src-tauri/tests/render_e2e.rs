//! End-to-end render verification against real ffmpeg on real media.
//!
//! These tests don't check that a filter string "looks right" — they render
//! actual output files and verify the *media result*: duration via ffprobe,
//! clip order and transforms via decoded frame pixels, audio delay/sync via
//! decoded PCM levels, and save/reopen fidelity via the project store.
//!
//! Skipped cleanly when `tools/bin/ffmpeg` is unavailable.

use creatora_lib::media::{self, probe};
use creatora_lib::project::document::*;
use creatora_lib::project::store;
use creatora_lib::render::commands::{resolve_sources, run_ffmpeg};
use creatora_lib::render::plan::{self, SourceInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn ffmpeg() -> Option<PathBuf> {
    media::ffmpeg_path()
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("creatora_e2e_{}_{}", tag, std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Generate a `W×H` solid-color clip with a sine tone — deterministic pixels
/// and a known-frequency audio signal for assertions.
fn make_clip(dir: &Path, name: &str, color: &str, freq: u32, secs: f64) -> PathBuf {
    let out = dir.join(name);
    if out.is_file() {
        return out;
    }
    let status = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", &format!("color=c={color}:s=320x240:d={secs}:r=30"),
            "-f", "lavfi", "-i", &format!("sine=frequency={freq}:duration={secs}"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        ])
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    out
}

fn render(dir: &Path, doc: &ProjectDoc, out_name: &str) -> PathBuf {
    let sources = resolve_sources(doc, None);
    let plan = plan::build_plan(doc, &sources).unwrap();
    let out = dir.join(out_name);
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();
    out
}

fn base_doc() -> ProjectDoc {
    ProjectDoc::new(
        "e2e",
        Canvas {
            width: 320,
            height: 240,
            fps_num: 30,
            fps_den: 1,
            background: "#000000".into(),
        },
    )
}

fn clip(id: &str, asset: &str, start_ms: i64, dur_ms: i64, src_in_ms: i64) -> Clip {
    Clip {
        id: id.into(),
        media_ref: Some(asset.into()),
        start_ms,
        duration_ms: dur_ms,
        source_in_ms: src_in_ms,
        source_out_ms: None,
        transform: Transform::default(),
        effects: vec![],
        volume: 1.0,
        speed: 1.0,
        text: None,
        keyframes: Default::default(),
    }
}

fn video_track(clips: Vec<Clip>) -> Track {
    Track {
        id: "v1".into(),
        kind: TrackKind::Video,
        name: "V1".into(),
        clips,
        locked: false,
        visible: true,
        muted: false,
    }
}

fn add_media(doc: &mut ProjectDoc, asset: &str, path: &Path) {
    doc.media_refs.push(MediaRef {
        asset_id: asset.into(),
        path: path.to_string_lossy().into_owned(),
        hash: None,
    });
}

/// Mean pixel value of a channel (0=R,1=G,2=B) in a rect of a raw rgb24 frame.
fn mean_channel(rgb: &[u8], w: usize, x: usize, y: usize, cw: usize, ch: usize, ch_i: usize) -> f64 {
    let mut sum = 0u64;
    let mut n = 0u64;
    for row in y..(y + ch) {
        for col in x..(x + cw) {
            sum += rgb[(row * w + col) * 3 + ch_i] as u64;
            n += 1;
        }
    }
    sum as f64 / n as f64
}

/// Extract a single frame at `t_s` seconds as rgb24 rawvideo.
fn grab_frame(video: &Path, t_s: f64, w: usize, h: usize) -> Vec<u8> {
    let out = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-ss", &format!("{t_s}"), "-i", &*video.to_string_lossy(),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ])
        .output()
        .unwrap();
    assert!(out.status.success(), "frame grab failed");
    assert_eq!(out.stdout.len(), w * h * 3, "unexpected frame size");
    out.stdout
}

fn duration_s(path: &Path) -> f64 {
    probe::probe(path).unwrap().duration_ms.unwrap() as f64 / 1000.0
}

/// Decode audio to mono 8 kHz s16 PCM; returns RMS of a time window.
fn audio_rms(path: &Path, from_s: f64, to_s: f64) -> f64 {
    let out = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", &*path.to_string_lossy(),
            "-f", "s16le", "-ac", "1", "-ar", "8000", "-",
        ])
        .output()
        .unwrap();
    assert!(out.status.success());
    let pcm = out.stdout;
    let (a, b) = ((from_s * 8000.0) as usize * 2, (to_s * 8000.0) as usize * 2);
    let (a, b) = (a.min(pcm.len()), b.min(pcm.len()));
    if b <= a {
        return 0.0;
    }
    let mut sum = 0f64;
    let mut n = 0usize;
    for i in (a..b - 1).step_by(2) {
        let s = i16::from_le_bytes([pcm[i], pcm[i + 1]]) as f64;
        sum += s * s;
        n += 1;
    }
    (sum / n.max(1) as f64).sqrt()
}

#[test]
fn export_trimmed_clip_has_trimmed_duration() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("trim");
    let src = make_clip(&dir, "red.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    add_media(&mut doc, "a1", &src);
    // 4 s source trimmed to 2 s starting at 0.5 s in.
    doc.timeline.tracks.push(video_track(vec![clip("c1", "a1", 0, 2000, 500)]));

    let out = render(&dir, &doc, "out.mp4");
    let d = duration_s(&out);
    assert!((d - 2.0).abs() < 0.15, "expected ~2.0s, got {d}");
}

#[test]
fn reordered_clips_render_in_new_order() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("order");
    let red = make_clip(&dir, "red.mp4", "red", 440, 2.0);
    let blue = make_clip(&dir, "blue.mp4", "blue", 880, 2.0);

    // Layout A: red then blue.
    let mut doc_a = base_doc();
    add_media(&mut doc_a, "r", &red);
    add_media(&mut doc_a, "b", &blue);
    doc_a.timeline.tracks.push(video_track(vec![
        clip("c1", "r", 0, 2000, 0),
        clip("c2", "b", 2000, 2000, 0),
    ]));
    let out_a = render(&dir, &doc_a, "a.mp4");

    // Layout B: same clips swapped.
    let mut doc_b = base_doc();
    doc_b.media_refs = doc_a.media_refs.clone();
    doc_b.timeline.tracks.push(video_track(vec![
        clip("c2", "b", 0, 2000, 0),
        clip("c1", "r", 2000, 2000, 0),
    ]));
    let out_b = render(&dir, &doc_b, "b.mp4");

    let (w, h) = (320usize, 240usize);
    // Frame at t=1.0 of A = red; of B = blue. Check channel dominance.
    let fa = grab_frame(&out_a, 1.0, w, h);
    let fb = grab_frame(&out_b, 1.0, w, h);
    let (ar, ab) = (mean_channel(&fa, w, 100, 60, 120, 120, 0), mean_channel(&fa, w, 100, 60, 120, 120, 2));
    let (br, bb) = (mean_channel(&fb, w, 100, 60, 120, 120, 0), mean_channel(&fb, w, 100, 60, 120, 120, 2));
    assert!(ar > ab + 40.0, "A@1s should be red-dominant (r={ar} b={ab})");
    assert!(bb > br + 40.0, "B@1s should be blue-dominant (r={br} b={bb})");

    // And symmetric: t=3.0 of A = blue, of B = red.
    let ga = grab_frame(&out_a, 3.0, w, h);
    let gb = grab_frame(&out_b, 3.0, w, h);
    assert!(mean_channel(&ga, w, 100, 60, 120, 120, 2) > mean_channel(&ga, w, 100, 60, 120, 120, 0) + 40.0);
    assert!(mean_channel(&gb, w, 100, 60, 120, 120, 0) > mean_channel(&gb, w, 100, 60, 120, 120, 2) + 40.0);
}

#[test]
fn transform_scale_and_position_land_on_canvas() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("xf");
    let src = make_clip(&dir, "red.mp4", "red", 440, 2.0);
    let mut doc = base_doc();
    add_media(&mut doc, "a1", &src);
    let mut c = clip("c1", "a1", 0, 2000, 0);
    // Half width at left edge → left 160 px red, right 160 black.
    c.transform.scale_x = 0.5;
    c.transform.x = -80.0;
    doc.timeline.tracks.push(video_track(vec![c]));

    let out = render(&dir, &doc, "out.mp4");
    let f = grab_frame(&out, 1.0, 320, 240);
    let left = mean_channel(&f, 320, 10, 60, 120, 120, 0);
    let right = mean_channel(&f, 320, 190, 60, 120, 120, 0);
    assert!(left > 120.0, "left half should be red (mean r={left})");
    assert!(right < 60.0, "right half should be black (mean r={right})");
}

#[test]
fn audio_follows_clip_timeline_position() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("sync");
    let src = make_clip(&dir, "tone.mp4", "red", 440, 2.0);
    let mut doc = base_doc();
    add_media(&mut doc, "a1", &src);
    // Clip placed at t=1s → output must be silent for ~1s then have tone.
    doc.timeline.tracks.push(video_track(vec![clip("c1", "a1", 1000, 2000, 0)]));

    let out = render(&dir, &doc, "out.mp4");
    let early = audio_rms(&out, 0.1, 0.8);
    let late = audio_rms(&out, 1.3, 2.6);
    assert!(early < 200.0, "expected silence at start, rms={early}");
    assert!(late > 2000.0, "expected tone after 1 s, rms={late}");
}

#[test]
fn image_clip_renders_for_its_duration() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("img");
    // A 4×4 green PNG scaled to 320×240 by ffmpeg.
    let img = dir.join("green.png");
    let st = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=green:s=320x240:d=0.1:r=1",
            "-frames:v", "1",
        ])
        .arg(&img)
        .status()
        .unwrap();
    assert!(st.success());

    let mut doc = base_doc();
    add_media(&mut doc, "img1", &img);
    // ffprobe reports still images as a "video" stream — the import pipeline
    // classifies by extension into `kind=image`, which drives `-loop 1`.
    // Without a catalog DB we supply that classification directly.
    let mut sources: HashMap<String, SourceInfo> = HashMap::new();
    sources.insert(
        "img1".into(),
        SourceInfo { path: img.clone(), kind: "image".into(), has_audio: false },
    );
    doc.timeline.tracks.push(video_track(vec![clip("c1", "img1", 0, 1500, 0)]));
    let plan = plan::build_plan(&doc, &sources).unwrap();
    let out = dir.join("out.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();
    let d = duration_s(&out);
    assert!((d - 1.5).abs() < 0.15, "expected ~1.5s, got {d}");
    let f = grab_frame(&out, 0.7, 320, 240);
    let g = mean_channel(&f, 320, 100, 60, 120, 120, 1);
    assert!(g > 80.0, "expected green frame, g={g}");
}

#[test]
fn save_reopen_preserves_timeline_exactly() {
    let dir = tmpdir("persist");
    let mut doc = base_doc();
    add_media(&mut doc, "a1", Path::new("/x/a.mp4"));
    let mut c = clip("c1", "a1", 1333, 2000, 500);
    c.volume = 0.7;
    c.transform.scale_x = 0.5;
    c.transform.x = 12.0;
    doc.timeline.tracks.push(video_track(vec![c]));
    doc.timeline.markers.push(Marker {
        id: "m1".into(),
        time_ms: 1500,
        label: "beat".into(),
        color: Some("#ff0000".into()),
    });

    let path = dir.join("p.creatora");
    store::save(&path, &doc).unwrap();
    let back = store::open(&path).unwrap();
    let a = serde_json::to_value(&doc.timeline).unwrap();
    let b = serde_json::to_value(&back.timeline).unwrap();
    assert_eq!(a, b, "timeline must round-trip byte-identical");
    assert_eq!(
        serde_json::to_value(&doc.media_refs).unwrap(),
        serde_json::to_value(&back.media_refs).unwrap()
    );
}

#[test]
fn cancelled_render_leaves_no_output() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("cancel");
    let src = make_clip(&dir, "red.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    add_media(&mut doc, "a1", &src);
    doc.timeline.tracks.push(video_track(vec![clip("c1", "a1", 0, 4000, 0)]));
    let sources = resolve_sources(&doc, None);
    let plan = plan::build_plan(&doc, &sources).unwrap();
    let out = dir.join("out.mp4");
    let r = run_ffmpeg(&plan, &out, |_| {}, || true);
    assert_eq!(r.unwrap_err(), "cancelled");
    assert!(!out.exists());
}
