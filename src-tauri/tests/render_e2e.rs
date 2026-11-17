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
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c={color}:s=320x240:d={secs}:r=30"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={freq}:duration={secs}"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    out
}

/// Same as `make_clip` with explicit size/fps — mixed-input validation.
#[allow(clippy::too_many_arguments)]
fn make_clip_sz(
    dir: &Path,
    name: &str,
    color: &str,
    freq: u32,
    secs: f64,
    w: u32,
    h: u32,
    r: u32,
) -> PathBuf {
    let out = dir.join(name);
    if out.is_file() {
        return out;
    }
    let status = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c={color}:s={w}x{h}:d={secs}:r={r}"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={freq}:duration={secs}"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
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
        source_duration_ms: None,
        transform: Transform::default(),
        effects: vec![],
        volume: 1.0,
        pan: 0.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        speed: 1.0,
        text: None,
        text_style: None,
        keyframes: Default::default(),
        shape: None,
        text_fx: None,
        hidden: false,
        brand_bindings: None,
    }
}

fn video_track(clips: Vec<Clip>) -> Track {
    Track {
        id: "v1".into(),
        kind: TrackKind::Video,
        name: "V1".into(),
        clips,
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
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
fn mean_channel(
    rgb: &[u8],
    w: usize,
    x: usize,
    y: usize,
    cw: usize,
    ch: usize,
    ch_i: usize,
) -> f64 {
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
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &format!("{t_s}"),
            "-i",
            &*video.to_string_lossy(),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
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
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &*path.to_string_lossy(),
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-",
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
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "a1", 0, 2000, 500)]));

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
    let (ar, ab) = (
        mean_channel(&fa, w, 100, 60, 120, 120, 0),
        mean_channel(&fa, w, 100, 60, 120, 120, 2),
    );
    let (br, bb) = (
        mean_channel(&fb, w, 100, 60, 120, 120, 0),
        mean_channel(&fb, w, 100, 60, 120, 120, 2),
    );
    assert!(
        ar > ab + 40.0,
        "A@1s should be red-dominant (r={ar} b={ab})"
    );
    assert!(
        bb > br + 40.0,
        "B@1s should be blue-dominant (r={br} b={bb})"
    );

    // And symmetric: t=3.0 of A = blue, of B = red.
    let ga = grab_frame(&out_a, 3.0, w, h);
    let gb = grab_frame(&out_b, 3.0, w, h);
    assert!(
        mean_channel(&ga, w, 100, 60, 120, 120, 2)
            > mean_channel(&ga, w, 100, 60, 120, 120, 0) + 40.0
    );
    assert!(
        mean_channel(&gb, w, 100, 60, 120, 120, 0)
            > mean_channel(&gb, w, 100, 60, 120, 120, 2) + 40.0
    );
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
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "a1", 1000, 2000, 0)]));

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
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=320x240:d=0.1:r=1",
            "-frames:v",
            "1",
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
        SourceInfo {
            path: img.clone(),
            kind: "image".into(),
            has_audio: false,
        },
    );
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "img1", 0, 1500, 0)]));
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
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "a1", 0, 4000, 0)]));
    let sources = resolve_sources(&doc, None);
    let plan = plan::build_plan(&doc, &sources).unwrap();
    let out = dir.join("out.mp4");
    let r = run_ffmpeg(&plan, &out, |_| {}, || true);
    assert_eq!(r.unwrap_err(), "cancelled");
    assert!(!out.exists());
}

// ---------- Phase 3B: effects / keyframes / transitions parity ----------

fn fx(kind: &str, params: &[(&str, f64)]) -> Effect {
    Effect {
        id: format!("fx-{kind}"),
        kind: kind.into(),
        enabled: true,
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect::<std::collections::BTreeMap<_, _>>(),
        in_ms: None,
        out_ms: None,
        file: None,
        times: None,
    }
}

fn kfs(pairs: &[(i64, f64)]) -> Vec<Keyframe> {
    pairs
        .iter()
        .map(|&(t_ms, v)| Keyframe {
            t_ms,
            v,
            ease: "linear".into(),
                anim: None,
        })
        .collect()
}

/// Whole-frame mean of one channel.
fn frame_mean(rgb: &[u8], w: usize, h: usize, ch_i: usize) -> f64 {
    mean_channel(rgb, w, 0, 0, w, h, ch_i)
}

#[test]
fn brightness_effect_brightens_rendered_pixels() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fx_bright");
    let gray = make_clip(&dir, "gray.mp4", "0x606060", 440, 1.0);

    let mut plain = base_doc();
    plain
        .timeline
        .tracks
        .push(video_track(vec![clip("c1", "g", 0, 800, 0)]));
    add_media(&mut plain, "g", &gray);
    let base_out = render(&dir, &plain, "plain.mp4");

    let mut bright = base_doc();
    let mut c = clip("c1", "g", 0, 800, 0);
    c.effects = vec![fx("brightness", &[("amount", 0.5)])];
    bright.timeline.tracks.push(video_track(vec![c]));
    add_media(&mut bright, "g", &gray);
    let fx_out = render(&dir, &bright, "bright.mp4");

    let a = grab_frame(&base_out, 0.4, 320, 240);
    let b = grab_frame(&fx_out, 0.4, 320, 240);
    let (ma, mb) = (frame_mean(&a, 320, 240, 0), frame_mean(&b, 320, 240, 0));
    // 1.5x multiply on ~0x60 luma: expect a large, positive delta.
    assert!(mb - ma > 30.0, "brightness delta too small: {ma} -> {mb}");
    assert!(mb < 255.0 && mb > ma, "unexpected mean {mb}");
}

#[test]
fn saturation_minus_one_desaturates() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fx_sat");
    let red = make_clip(&dir, "red.mp4", "red", 440, 1.0);

    let mut doc = base_doc();
    let mut c = clip("c1", "r", 0, 800, 0);
    c.effects = vec![fx("saturation", &[("amount", -1.0)])];
    doc.timeline.tracks.push(video_track(vec![c]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "gray.mp4");

    let f = grab_frame(&out, 0.4, 320, 240);
    let (r, g, b) = (
        frame_mean(&f, 320, 240, 0),
        frame_mean(&f, 320, 240, 1),
        frame_mean(&f, 320, 240, 2),
    );
    // Full desaturation → all channels converge to luma.
    assert!((r - g).abs() < 12.0, "r={r} g={g}");
    assert!((g - b).abs() < 12.0, "g={g} b={b}");
}

#[test]
fn crossfade_blends_midpoint_between_clips() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("xfade");
    let red = make_clip(&dir, "red.mp4", "red", 440, 4.0);
    let blue = make_clip(&dir, "blue.mp4", "blue", 440, 4.0);

    // A red 0..2000ms, B blue 1500..3500ms, 1s crossfade over the overlap.
    let mut doc = base_doc();
    let mut track = video_track(vec![
        clip("a", "r", 0, 2000, 0),
        clip("b", "b", 1500, 2000, 0),
    ]);
    track.transitions.push(Transition {
        id: "t1".into(),
        kind: "crossfade".into(),
        duration_ms: 500,
        clip_a: "a".into(),
        clip_b: "b".into(),
        params: Default::default(),
        ease: None,
    });
    doc.timeline.tracks.push(track);
    add_media(&mut doc, "r", &red);
    add_media(&mut doc, "b", &blue);
    let out = render(&dir, &doc, "xfade.mp4");

    // Before overlap: pure red.
    let f1 = grab_frame(&out, 1.0, 320, 240);
    assert!(frame_mean(&f1, 320, 240, 0) > 120.0 && frame_mean(&f1, 320, 240, 2) < 40.0);
    // Mid-fade (t=1.75): red and blue both present (blend).
    let fm = grab_frame(&out, 1.75, 320, 240);
    let (r, b) = (frame_mean(&fm, 320, 240, 0), frame_mean(&fm, 320, 240, 2));
    assert!(r > 50.0 && b > 50.0 && r < 200.0, "mid blend r={r} b={b}");
    // After overlap: pure blue.
    let f2 = grab_frame(&out, 3.0, 320, 240);
    assert!(frame_mean(&f2, 320, 240, 2) > 120.0 && frame_mean(&f2, 320, 240, 0) < 40.0);
}

#[test]
fn opacity_keyframe_ramps_over_clip() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("kf_opacity");
    let gray = make_clip(&dir, "gray.mp4", "0x909090", 440, 2.0);

    // opacity 0→1 over the 1s clip on black canvas.
    let mut doc = base_doc();
    let mut c = clip("c1", "g", 0, 1000, 0);
    c.keyframes
        .insert("transform.opacity".into(), kfs(&[(0, 0.0), (1000, 1.0)]));
    doc.timeline.tracks.push(video_track(vec![c]));
    add_media(&mut doc, "g", &gray);
    let out = render(&dir, &doc, "fadein.mp4");

    let m25 = frame_mean(&grab_frame(&out, 0.25, 320, 240), 320, 240, 0);
    let m75 = frame_mean(&grab_frame(&out, 0.75, 320, 240), 320, 240, 0);
    // Monotonic ramp; quarter-time ≈ 25% of ~0x90 luma.
    assert!(m25 < m75 - 20.0, "no ramp: {m25} vs {m75}");
    assert!(m25 > 10.0 && m25 < 80.0, "m25={m25}");
    assert!(m75 > 90.0, "m75={m75}");
}

#[test]
fn volume_keyframe_ramps_audio() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("kf_vol");
    let tone = make_clip(&dir, "tone.mp4", "black", 440, 2.0);

    let mut doc = base_doc();
    let mut c = clip("c1", "t", 0, 2000, 0);
    c.keyframes
        .insert("volume".into(), kfs(&[(0, 0.0), (2000, 1.0)]));
    doc.timeline.tracks.push(video_track(vec![c]));
    add_media(&mut doc, "t", &tone);
    let out = render(&dir, &doc, "vol.mp4");

    let early = audio_rms(&out, 0.1, 0.4);
    let late = audio_rms(&out, 1.6, 1.9);
    assert!(late > early * 2.0, "volume ramp missing: {early} vs {late}");
}

// ---------- Phase 3D: realistic commercial scenarios ----------

/// ffprobe stream summary "WxH fps" for the first video stream.
fn probe_meta(path: &Path) -> (u32, u32, f64) {
    let out = Command::new(media::ffprobe_path().unwrap())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    let f = s.trim().split(',').collect::<Vec<_>>();
    let rate: Vec<&str> = f[2].split('/').collect();
    let fps = rate[0].parse::<f64>().unwrap() / rate.get(1).unwrap_or(&"1").parse::<f64>().unwrap();
    (f[0].parse().unwrap(), f[1].parse().unwrap(), fps)
}

#[test]
fn mixed_resolution_and_fps_normalize_to_canvas() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("mixed");
    // Small slow source + large fast source on the same 320x240@30 canvas.
    let small = make_clip_sz(&dir, "small.mp4", "red", 440, 2.0, 160, 120, 15);
    let big = make_clip_sz(&dir, "big.mp4", "blue", 440, 2.0, 640, 480, 60);

    let mut doc = base_doc();
    doc.timeline.tracks.push(video_track(vec![
        clip("a", "s", 0, 1000, 0),
        clip("b", "b", 1000, 1000, 0),
    ]));
    add_media(&mut doc, "s", &small);
    add_media(&mut doc, "b", &big);
    let out = render(&dir, &doc, "mixed.mp4");

    let (w, h, fps) = probe_meta(&out);
    assert_eq!((w, h), (320, 240));
    assert!((fps - 30.0).abs() < 0.01, "fps={fps}");
    // Both fill the canvas (AR 4:3 == canvas): correct color each half.
    let f1 = grab_frame(&out, 0.5, 320, 240);
    assert!(frame_mean(&f1, 320, 240, 0) > 120.0 && frame_mean(&f1, 320, 240, 2) < 40.0);
    let f2 = grab_frame(&out, 1.5, 320, 240);
    assert!(frame_mean(&f2, 320, 240, 2) > 120.0 && frame_mean(&f2, 320, 240, 0) < 40.0);
}

#[test]
fn stacked_tracks_composite_in_z_order() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("zorder");
    let red = make_clip(&dir, "red.mp4", "red", 440, 2.0);
    let blue = make_clip(&dir, "blue.mp4", "blue", 440, 2.0);

    // Bottom: full red. Top: blue at 50% scale centered → center blue, edge red.
    let mut doc = base_doc();
    let mut top = clip("top", "b", 0, 2000, 0);
    top.transform.scale_x = 0.5;
    top.transform.scale_y = 0.5;
    doc.timeline
        .tracks
        .push(video_track(vec![clip("bot", "r", 0, 2000, 0)]));
    doc.timeline.tracks.push(Track {
        id: "v2".into(),
        kind: TrackKind::Video,
        name: "V2".into(),
        clips: vec![top],
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    });
    add_media(&mut doc, "r", &red);
    add_media(&mut doc, "b", &blue);
    let out = render(&dir, &doc, "z.mp4");

    let f = grab_frame(&out, 1.0, 320, 240);
    // Center must be blue, corners red (z-order: later track on top).
    let center = mean_channel(&f, 320, 140, 100, 40, 40, 2);
    let corner = mean_channel(&f, 320, 5, 5, 40, 40, 0);
    assert!(center > 120.0, "center blue={center}");
    assert!(corner > 120.0, "corner red={corner}");
}

#[test]
fn long_project_many_clips_renders_full_duration() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("long");
    let colors = ["red", "green", "blue", "yellow"];
    let mut paths = Vec::new();
    for (i, c) in colors.iter().enumerate() {
        paths.push(make_clip(&dir, &format!("c{i}.mp4"), c, 440, 2.0));
    }
    // 16 sequential 1s clips = 16s timeline.
    let mut doc = base_doc();
    let mut clips = Vec::new();
    for i in 0..16 {
        clips.push(clip(
            &format!("k{i}"),
            &format!("m{}", i % 4),
            i * 1000,
            1000,
            0,
        ));
    }
    doc.timeline.tracks.push(video_track(clips));
    for (i, p) in paths.iter().enumerate() {
        add_media(&mut doc, &format!("m{i}"), p);
    }
    let out = render(&dir, &doc, "long.mp4");
    let d = duration_s(&out);
    assert!((d - 16.0).abs() < 0.4, "duration {d}");
    // Spot-check order survived: clip 0 red ~0.5s, clip 12 red ~12.5s,
    // clip 5 = green ~5.5s.
    let f0 = grab_frame(&out, 0.5, 320, 240);
    assert!(frame_mean(&f0, 320, 240, 0) > 120.0);
    let f5 = grab_frame(&out, 5.5, 320, 240);
    assert!(frame_mean(&f5, 320, 240, 1) > 80.0, "clip5 not green");
}

#[test]
fn high_res_canvas_renders_at_full_size() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("hires");
    let src = make_clip(&dir, "src.mp4", "red", 440, 1.0);
    let mut doc = base_doc();
    doc.canvas.width = 1280;
    doc.canvas.height = 720;
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "s", 0, 800, 0)]));
    add_media(&mut doc, "s", &src);
    let out = render(&dir, &doc, "hd.mp4");
    let (w, h, _fps) = probe_meta(&out);
    assert_eq!((w, h), (1280, 720));
    let f = grab_frame(&out, 0.4, 1280, 720);
    assert!(frame_mean(&f, 1280, 720, 0) > 120.0);
}

// ---------- Phase 3E: compatibility matrix & hardening ----------

/// Project doc at a rational canvas fps (fps_num/fps_den).
fn doc_fps(num: u32, den: u32) -> ProjectDoc {
    let mut d = base_doc();
    d.canvas.fps_num = num;
    d.canvas.fps_den = den;
    d
}

#[test]
fn fractional_fps_canvas_23976_produces_exact_rate() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fps23976");
    let src = make_clip_sz(&dir, "src.mp4", "red", 440, 2.0, 320, 240, 24);
    let mut doc = doc_fps(24000, 1001);
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "s", 0, 1500, 0)]));
    add_media(&mut doc, "s", &src);
    let out = render(&dir, &doc, "out.mp4");
    let (_w, _h, fps) = probe_meta(&out);
    assert!((fps - 23.976).abs() < 0.01, "fps={fps}");
    // duration within a frame of the 1.5s clip
    let d = duration_s(&out);
    assert!((d - 1.5).abs() < 0.2, "d={d}");
}

#[test]
fn fractional_fps_canvas_5994_produces_exact_rate() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fps5994");
    let src = make_clip_sz(&dir, "src.mp4", "blue", 440, 2.0, 320, 240, 60);
    let mut doc = doc_fps(60000, 1001);
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "s", 0, 1000, 0)]));
    add_media(&mut doc, "s", &src);
    let out = render(&dir, &doc, "out.mp4");
    let (_w, _h, fps) = probe_meta(&out);
    assert!((fps - 59.94).abs() < 0.01, "fps={fps}");
}

#[test]
fn vfr_source_conforms_to_cfr_canvas() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("vfr");
    // VFR source: concat of 15fps + 45fps halves via filter — simplest
    // reliable VFR is minterpolate-free: generate CFR pieces and mux concat
    // with different source rates → ffprobe shows variable rate.
    let a = dir.join("vfr_a.mp4");
    let b = dir.join("vfr_b.mp4");
    for (p, r) in [(&a, 15), (&b, 45)] {
        let st = Command::new(ffmpeg().unwrap())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=red:s=320x240:d=1:r={r}"),
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(p)
            .status()
            .unwrap();
        assert!(st.success());
    }
    // Concat demuxer keeps each segment's timestamps → VFR container.
    let list = dir.join("list.txt");
    std::fs::write(
        &list,
        format!(
            "file '{}'\nfile '{}'",
            a.to_string_lossy().replace("\\", "/"),
            b.to_string_lossy().replace("\\", "/"),
        ),
    )
    .unwrap();
    let vfr = dir.join("vfr.mp4");
    let st = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(&list)
        .args(["-c", "copy"])
        .arg(&vfr)
        .status()
        .unwrap();
    assert!(st.success());

    let mut doc = base_doc(); // 30fps canvas
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "v", 0, 1500, 0)]));
    add_media(&mut doc, "v", &vfr);
    let out = render(&dir, &doc, "out.mp4");
    let (_w, _h, fps) = probe_meta(&out);
    assert!((fps - 30.0).abs() < 0.01, "fps={fps}");
    let d = duration_s(&out);
    assert!((d - 1.5).abs() < 0.3, "d={d}");
}

#[test]
fn av_sync_holds_across_long_timeline() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("sync_long");
    // 20s timeline: tone-bearing clips at start, middle and end.
    let tone = make_clip(&dir, "tone.mp4", "black", 880, 30.0);
    let silence = make_clip(&dir, "sil.mp4", "0x202020", 0, 30.0); // freq 0 ≈ silent
    let mut doc = base_doc();
    doc.timeline.tracks.push(video_track(vec![
        clip("a", "t", 0, 1000, 0),         // tone 0-1s
        clip("b", "q", 1000, 9000, 0),      // quiet 1-10s
        clip("c", "t", 10000, 1000, 5000),  // tone 10-11s (src 5s)
        clip("d", "q", 11000, 8000, 0),     // quiet 11-19s
        clip("e", "t", 19000, 1000, 10000), // tone 19-20s (src 10s)
    ]));
    add_media(&mut doc, "t", &tone);
    add_media(&mut doc, "q", &silence);
    let out = render(&dir, &doc, "sync.mp4");

    // Tone present at start/middle/end windows.
    assert!(audio_rms(&out, 0.2, 0.8) > 500.0, "start tone missing");
    assert!(audio_rms(&out, 10.2, 10.8) > 500.0, "mid tone missing");
    assert!(audio_rms(&out, 19.2, 19.8) > 500.0, "end tone missing");
    // Silent gaps really are quiet → no drift-introduced overlap.
    assert!(audio_rms(&out, 5.0, 6.0) < 200.0, "gap 5-6s not quiet");
    assert!(audio_rms(&out, 15.0, 16.0) < 200.0, "gap 15-16s not quiet");
}

#[test]
fn clip_at_timeline_edges_handles_boundaries() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("edges");
    let red = make_clip(&dir, "r.mp4", "red", 440, 2.0);
    // 1-frame clip at t=0 and a clip ending exactly at timeline end.
    let mut doc = base_doc();
    let mut one_frame = clip("f", "r", 0, 33, 0); // ~1 frame @30fps
    one_frame.duration_ms = 33;
    doc.timeline.tracks.push(video_track(vec![
        one_frame,
        clip("tail", "r", 33, 967, 500),
    ]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "edges.mp4");
    let d = duration_s(&out);
    assert!((d - 1.0).abs() < 0.15, "d={d}");
}

#[test]
fn multi_audio_stream_uses_first_stream() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("multiaudio");
    // Source with two audio streams (440Hz + 880Hz).
    let src = dir.join("dual.mp4");
    let st = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x240:d=2:r=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=2",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "m", 0, 1500, 0)]));
    add_media(&mut doc, "m", &src);
    let out = render(&dir, &doc, "out.mp4");
    // Output has exactly one audio stream (first source stream).
    let n = Command::new(media::ffprobe_path().unwrap())
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(&out)
        .output()
        .unwrap();
    let streams = String::from_utf8_lossy(&n.stdout).lines().count();
    assert_eq!(streams, 1, "expected single output audio stream");
    assert!(audio_rms(&out, 0.2, 0.8) > 500.0);
}

#[test]
fn text_clip_renders_glyphs_on_canvas() {
    if ffmpeg().is_none() {
        return;
    }
    if !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return; // default font unavailable on this box
    }
    let dir = tmpdir("text");
    let red = make_clip(&dir, "r.mp4", "red", 440, 2.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 2000, 0)]));
    doc.timeline.tracks.push(Track {
        id: "tt".into(),
        kind: TrackKind::Text,
        name: "T1".into(),
        clips: vec![Clip {
            id: "txt".into(),
            media_ref: None,
            start_ms: 0,
            duration_ms: 2000,
            source_in_ms: 0,
            source_out_ms: None,
            source_duration_ms: None,
            transform: Transform::default(),
            effects: vec![],
            volume: 1.0,
            pan: 0.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            speed: 1.0,
            text: Some("HELLO".into()),
            text_style: Some(TextStyle {
                font_size_px: 80.0,
                color: "#FFFFFF".into(),
                align_h: "center".into(),
                align_v: "middle".into(),
                ..Default::default()
            }),
            keyframes: Default::default(),
            shape: None,
            text_fx: None,
            hidden: false,
            brand_bindings: None,
        }],
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    });
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "text.mp4");
    let f = grab_frame(&out, 1.0, 320, 240);
    // Center region: white glyph pixels over red background.
    // Look for bright-white pixels (all channels high) in the middle band.
    let mut white = 0u64;
    for row in 90..150 {
        for col in 60..260 {
            let i = (row * 320 + col) * 3;
            if f[i] > 200 && f[i + 1] > 200 && f[i + 2] > 200 {
                white += 1;
            }
        }
    }
    assert!(white > 500, "expected text pixels, got {white}");
}

#[test]
fn keyframe_eval_parity_table() {
    // Shared vectors: TS evalKeyframes (effects.ts) must produce identical
    // results — same linear model. Any drift here = preview/render mismatch.
    let kf = |t: i64, v: f64| Keyframe {
        t_ms: t,
        v,
        ease: "linear".into(),
                anim: None,
    };
    let cases: Vec<(Vec<Keyframe>, i64, f64, f64)> = vec![
        (vec![], 500, 0.7, 0.7),                            // empty → base
        (vec![kf(100, 0.0), kf(900, 1.0)], 500, 0.0, 0.5),  // mid lerp
        (vec![kf(100, 0.0), kf(900, 1.0)], 0, 0.0, 0.0),    // before → first
        (vec![kf(100, 0.0), kf(900, 1.0)], 5000, 0.0, 1.0), // after → last
        (vec![kf(0, 2.0), kf(1000, -1.0)], 250, 9.0, 1.25), // down-ramp
        (vec![kf(0, 1.0), kf(500, 3.0), kf(1000, 2.0)], 750, 0.0, 2.5), // mid segment
        (vec![kf(200, 5.0)], 0, 1.0, 5.0),                  // single key → clamp
    ];
    for (kfs, t, base, want) in cases {
        let got = creatora_lib::render::keyframes::eval_at(&kfs, t, base);
        assert!((got - want).abs() < 1e-9, "t={t}: got {got} want {want}");
    }
}

// ---------- stress: scale + real timing ----------

#[test]
fn stress_plan_builds_at_scale() {
    // 20 tracks × 5 clips (100 clips), 30-min timeline — build_plan must
    // stay tractable; measure real time for regression tracking.
    let mut doc = base_doc();
    add_media(&mut doc, "m", Path::new("x.mp4"));
    for t in 0..20 {
        let mut tr = video_track(vec![]);
        tr.id = format!("v{t}");
        tr.name = format!("V{t}");
        for c in 0..5 {
            tr.clips.push(clip(
                &format!("c{t}_{c}"),
                "m",
                (c * 6 * 60_000) as i64, // 5×6min ≈ 30min
                60_000,
                0,
            ));
        }
        doc.timeline.tracks.push(tr);
    }
    let mut sources = HashMap::new();
    sources.insert(
        "m".to_string(),
        SourceInfo {
            path: PathBuf::from("x.mp4"),
            kind: "video".into(),
            has_audio: true,
        },
    );
    let t0 = std::time::Instant::now();
    let plan = plan::build_plan(&doc, &sources).unwrap();
    let el = t0.elapsed();
    eprintln!(
        "[stress] 20 tracks × 100 clips, 30min: build_plan in {el:?}, filter graph {} bytes",
        plan.filter_complex.len()
    );
    assert!(!plan.filter_complex.is_empty());
    assert!(el.as_secs() < 10, "plan build too slow: {el:?}");
}

#[test]
fn stress_render_50_clips_timing() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("stress50");
    let red = make_clip(&dir, "r.mp4", "red", 220, 1.0);
    let mut doc = base_doc();
    // 50 clips × 400ms = 20s timeline, single source.
    let mut clips = Vec::new();
    for i in 0..50 {
        clips.push(clip(&format!("c{i}"), "r", (i * 400) as i64, 400, 0));
    }
    doc.timeline.tracks.push(video_track(clips));
    add_media(&mut doc, "r", &red);
    let out = dir.join("s50.mp4");
    let sources = resolve_sources(&doc, None);
    let plan = plan::build_plan(&doc, &sources).unwrap();
    eprintln!(
        "[stress] 50-clip filter graph: {} bytes",
        plan.filter_complex.len()
    );
    let t0 = std::time::Instant::now();
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();
    let el = t0.elapsed();
    eprintln!("[stress] 50 clips rendered in {el:?}");
    let d = duration_s(&out);
    assert!((d - 20.0).abs() < 0.35, "dur {d}");
}

// ---------- Phase 4: multi-format versions ----------

#[test]
fn version_merge_overrides_only_whitelisted() {
    use creatora_lib::project::document::*;
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "m", 0, 1000, 0)]));
    let ov = ClipOverride {
        transform: Some(Transform {
            x: 50.0,
            scale_x: 2.0,
            scale_y: 2.0,
            ..Default::default()
        }),
        keyframes: [(
            "transform.opacity".into(),
            vec![Keyframe {
                t_ms: 0,
                v: 0.0,
                ease: "linear".into(),
                anim: None,
            }],
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    doc.versions.push(FormatVersion {
        id: "v9x16".into(),
        name: "9:16".into(),
        preset_id: Some("ar-9x16".into()),
        canvas: Canvas {
            width: 1080,
            height: 1920,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: [("c1".to_string(), ov)].into_iter().collect(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });
    let merged = doc.apply_version("v9x16").unwrap();
    assert_eq!(merged.canvas.width, 1080);
    assert_eq!(merged.canvas.height, 1920);
    let c = &merged.timeline.tracks[0].clips[0];
    assert_eq!(c.transform.x, 50.0);
    assert_eq!(c.transform.scale_x, 2.0);
    assert_eq!(c.keyframes["transform.opacity"][0].v, 0.0);
    // Untouched fields identical — timeline structure shared.
    assert_eq!(c.start_ms, 0);
    assert_eq!(c.duration_ms, 1000);
    // Base doc unchanged — version edits never leak back.
    assert_eq!(doc.canvas.width, 320);
    assert_eq!(doc.timeline.tracks[0].clips[0].transform.x, 0.0);
    assert!(doc.versions[0].clip_overrides.contains_key("c1"));
}

#[test]
fn versions_round_trip_persistence() {
    use creatora_lib::project::document::*;
    let mut doc = base_doc();
    doc.versions.push(FormatVersion {
        id: "sq".into(),
        name: "Square".into(),
        preset_id: Some("ar-1x1".into()),
        canvas: Canvas {
            width: 1080,
            height: 1080,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones {
            top: 0.1,
            ..Default::default()
        },
        clip_overrides: Default::default(),
        export: ExportSettings {
            crf: 18,
            ..Default::default()
        },
        subtitle_style: None,
    });
    let json = serde_json::to_string(&doc).unwrap();
    let back = ProjectDoc::parse(&json).unwrap();
    assert_eq!(back.versions.len(), 1);
    assert_eq!(back.versions[0].canvas.height, 1080);
    assert_eq!(back.versions[0].export.crf, 18);
    assert!((back.versions[0].safe_zones.top - 0.1).abs() < 1e-6);
    // v1 file without versions still parses.
    let v1 = json.replace("\"versions\":", "\"versions_unused\":");
    let back2 = ProjectDoc::parse(&v1);
    assert!(back2.is_ok());
}

#[test]
fn motion_analysis_tracks_moving_subject() {
    if ffmpeg().is_none() {
        return;
    }
    // Real moving subject: white box sweeping left→right on black.
    let dir = tmpdir("reframe");
    let src = dir.join("moving.mp4");
    // overlay re-evaluates per frame — a REAL moving subject.
    let ok = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=black:size=320x240:rate=30:d=4",
            "-f",
            "lavfi",
            "-i",
            "color=white:size=40x40:rate=30:d=4",
            "-filter_complex",
            "[0:v][1:v]overlay=x=t*60:y=100",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(ok.success());
    let samples = creatora_lib::render::reframe::analyze_motion(&src, 0, 4000, 12).unwrap();
    assert!(samples.len() >= 4, "got {} samples", samples.len());
    // Centroid x must increase over time (box moves right).
    let first: Vec<f64> = samples.iter().take(3).map(|s| s.cx).collect();
    let last: Vec<f64> = samples.iter().rev().take(3).map(|s| s.cx).collect();
    let f0 = first.iter().sum::<f64>() / first.len() as f64;
    let f1 = last.iter().sum::<f64>() / last.len() as f64;
    assert!(f1 > f0 + 0.1, "subject not tracked: {f0} → {f1}");
    assert!(samples.iter().any(|s| s.motion), "no motion detected");
}

#[test]
fn version_16x9_to_square_cover_reframe_pixels() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fmt_sq");
    // Source: left half RED, right half BLUE — distinct windows.
    let src = dir.join("split.mp4");
    let ok = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:size=160x240:rate=30:d=2",
            "-f",
            "lavfi",
            "-i",
            "color=blue:size=160x240:rate=30:d=2",
            "-filter_complex",
            "[0:v][1:v]hstack",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(ok.success());

    // Base doc 320×240 (16:9-ish); version 240×240 (1:1) reframed to the
    // RIGHT half (focus x=1.0) via cover-fit transform override.
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "m", 0, 2000, 0)]));
    add_media(&mut doc, "m", &src);

    // cover/fit scale for 320x240 → 240x240: fit=0.75, cover=1.0 → 4/3.
    // focusX=1 → window sits on the right edge (transform.x = -w/2 = -160).
    let ov = ClipOverride {
        transform: Some(Transform {
            x: -160.0,
            y: 0.0,
            scale_x: 4.0 / 3.0,
            scale_y: 4.0 / 3.0,
            ..Default::default()
        }),
        ..Default::default()
    };
    doc.versions.push(FormatVersion {
        id: "sq".into(),
        name: "1:1".into(),
        preset_id: None,
        canvas: Canvas {
            width: 240,
            height: 240,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: [("c1".to_string(), ov)].into_iter().collect(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });

    let merged = doc.apply_version("sq").unwrap();
    let sources = resolve_sources(&merged, None);
    let plan = plan::build_plan(&merged, &sources).unwrap();
    let out = dir.join("sq.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();

    // Dimensions verified via ffprobe.
    let (w, h, _) = probe_meta(&out);
    assert_eq!((w, h), (240, 240));

    // Pixel check: the cover window shows the BLUE (right) half.
    let f = grab_frame(&out, 1.0, 240, 240);
    let blue = mean_channel(&f, 240, 100, 100, 40, 40, 2);
    let red = mean_channel(&f, 240, 100, 100, 40, 40, 0);
    assert!(blue > 0.6, "expected blue window, blue={blue}");
    assert!(red < 0.3, "expected no red, red={red}");
}

#[test]
fn version_16x9_to_vertical_keeps_center_window() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fmt_916");
    // Horizontal thirds: RED | GREEN | BLUE — vertical crop should show GREEN.
    let src = dir.join("thirds.mp4");
    let ok = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:size=108x136:rate=30:d=2",
            "-f",
            "lavfi",
            "-i",
            "color=green:size=104x136:rate=30:d=2",
            "-f",
            "lavfi",
            "-i",
            "color=blue:size=108x136:rate=30:d=2",
            "-filter_complex",
            "[0:v][1:v][2:v]hstack=inputs=3",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(ok.success());

    // Base 320×136 → version 136×240 (portrait, taller than wide).
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "m", 0, 2000, 0)]));
    add_media(&mut doc, "m", &src);

    // cover 320x135 → 135x240: fit=min(135/320,240/135)=0.422;
    // cover=max(…)=1.778 → scale=1.778/0.422=4.2148… exact: cover/fit.
    let fit = (136.0f64 / 320.0).min(240.0 / 136.0);
    let cover = (136.0f64 / 320.0).max(240.0 / 136.0);
    let ov = ClipOverride {
        transform: Some(Transform {
            x: 0.0,
            y: 0.0,
            scale_x: (cover / fit) as f32,
            scale_y: (cover / fit) as f32,
            ..Default::default()
        }),
        ..Default::default()
    };
    doc.versions.push(FormatVersion {
        id: "v".into(),
        name: "9:16".into(),
        preset_id: None,
        canvas: Canvas {
            width: 136,
            height: 240,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: [("c1".to_string(), ov)].into_iter().collect(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });

    let merged = doc.apply_version("v").unwrap();
    let sources = resolve_sources(&merged, None);
    let plan = plan::build_plan(&merged, &sources).unwrap();
    let out = dir.join("v.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();

    let (w, h, _) = probe_meta(&out);
    assert_eq!((w, h), (136, 240));
    let f = grab_frame(&out, 1.0, 136, 240);
    // Centered window → GREEN third dominates center column.
    let g = mean_channel(&f, 136, 55, 100, 25, 40, 1);
    let r = mean_channel(&f, 136, 55, 100, 25, 40, 0);
    assert!(g > r * 1.5, "expected green center, g={g} r={r}");
}

#[test]
fn version_keyframed_reframe_moves_window() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fmt_kf");
    let src = dir.join("split.mp4");
    Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:size=160x240:rate=30:d=2",
            "-f",
            "lavfi",
            "-i",
            "color=blue:size=160x240:rate=30:d=2",
            "-filter_complex",
            "[0:v][1:v]hstack",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&src)
        .status()
        .unwrap();
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "m", 0, 2000, 0)]));
    add_media(&mut doc, "m", &src);

    // 1:1 version, animated pan: start on LEFT half (focus 0 → x=+160),
    // end on RIGHT half (x=-160) via version-scoped transform.x keyframes.
    let ov = ClipOverride {
        transform: Some(Transform {
            x: 160.0,
            scale_x: 4.0 / 3.0,
            scale_y: 4.0 / 3.0,
            ..Default::default()
        }),
        keyframes: [(
            "transform.x".into(),
            vec![
                Keyframe {
                    t_ms: 0,
                    v: 160.0,
                    ease: "linear".into(),
                anim: None,
                },
                Keyframe {
                    t_ms: 2000,
                    v: -160.0,
                    ease: "linear".into(),
                anim: None,
                },
            ],
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    doc.versions.push(FormatVersion {
        id: "sq".into(),
        name: "sq".into(),
        preset_id: None,
        canvas: Canvas {
            width: 240,
            height: 240,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: [("c1".to_string(), ov)].into_iter().collect(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });
    let merged = doc.apply_version("sq").unwrap();
    let sources = resolve_sources(&merged, None);
    let plan = plan::build_plan(&merged, &sources).unwrap();
    let out = dir.join("pan.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();

    let early = grab_frame(&out, 0.2, 240, 240);
    let late = grab_frame(&out, 1.8, 240, 240);
    let e_red = mean_channel(&early, 240, 100, 100, 40, 40, 0);
    let l_blue = mean_channel(&late, 240, 100, 100, 40, 40, 2);
    assert!(e_red > 0.6, "early should be red: {e_red}");
    assert!(l_blue > 0.6, "late should be blue: {l_blue}");
}

#[test]
fn multi_version_export_produces_all_formats() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("fmt_batch");
    let red = make_clip(&dir, "r.mp4", "red", 220, 1.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 1000, 0)]));
    add_media(&mut doc, "r", &red);
    for (id, w, h) in [("v916", 240u32, 426u32), ("v11", 240, 240)] {
        doc.versions.push(FormatVersion {
            id: id.into(),
            name: id.into(),
            preset_id: None,
            canvas: Canvas {
                width: w,
                height: h,
                fps_num: 30,
                fps_den: 1,
                background: "#000".into(),
            },
            safe_zones: SafeZones::default(),
            clip_overrides: Default::default(),
            export: ExportSettings::default(),
            subtitle_style: None,
        });
    }
    // Same loop export_versions' jobs run.
    for (id, w, h) in [
        (None, 320u32, 240u32),
        (Some("v916"), 240, 426),
        (Some("v11"), 240, 240),
    ] {
        let d = match id {
            Some(v) => doc.apply_version(v).unwrap(),
            None => doc.clone(),
        };
        let sources = resolve_sources(&d, None);
        let plan = plan::build_plan(&d, &sources).unwrap();
        let out = dir.join(format!("{}.mp4", id.unwrap_or("master")));
        run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();
        let (ow, oh, _) = probe_meta(&out);
        assert_eq!((ow, oh), (w, h), "version {id:?} wrong dims");
    }
}

#[test]
fn text_clip_renders_in_vertical_version() {
    if ffmpeg().is_none() {
        return;
    }
    if !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("fmt_text");
    let red = make_clip(&dir, "r.mp4", "red", 220, 1.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 1000, 0)]));
    doc.timeline.tracks.push(Track {
        id: "tt".into(),
        kind: TrackKind::Text,
        name: "T1".into(),
        clips: vec![Clip {
            id: "txt".into(),
            media_ref: None,
            start_ms: 0,
            duration_ms: 1000,
            source_in_ms: 0,
            source_out_ms: None,
            source_duration_ms: None,
            transform: Transform::default(),
            effects: vec![],
            volume: 1.0,
            pan: 0.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            speed: 1.0,
            text: Some("HI".into()),
            text_style: Some(TextStyle {
                font_size_px: 60.0,
                color: "#FFFFFF".into(),
                align_h: "center".into(),
                align_v: "middle".into(),
                ..Default::default()
            }),
            keyframes: Default::default(),
            shape: None,
            text_fx: None,
            hidden: false,
            brand_bindings: None,
        }],
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    });
    add_media(&mut doc, "r", &red);
    doc.versions.push(FormatVersion {
        id: "v916".into(),
        name: "v".into(),
        preset_id: None,
        canvas: Canvas {
            width: 240,
            height: 426,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: Default::default(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });
    let merged = doc.apply_version("v916").unwrap();
    let sources = resolve_sources(&merged, None);
    let plan = plan::build_plan(&merged, &sources).unwrap();
    let out = dir.join("v.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();
    let (w, h, _) = probe_meta(&out);
    assert_eq!((w, h), (240, 426));
    let f = grab_frame(&out, 0.5, 240, 426);
    let mut white = 0u64;
    for row in 180..250 {
        for col in 60..180 {
            let i = (row * 240 + col) * 3;
            if f[i] > 200 && f[i + 1] > 200 && f[i + 2] > 200 {
                white += 1;
            }
        }
    }
    assert!(
        white > 200,
        "expected text pixels in vertical version, got {white}"
    );
}

#[test]
fn versions_survive_save_reopen() {
    use creatora_lib::project::document::*;
    let dir = tmpdir("fmt_persist");
    let mut doc = base_doc();
    doc.versions.push(FormatVersion {
        id: "v1".into(),
        name: "A".into(),
        preset_id: Some("ar-1x1".into()),
        canvas: Canvas {
            width: 640,
            height: 640,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: Default::default(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });
    let path = dir.join("p.creatora");
    store::save(&path, &doc).unwrap();
    let back = store::open(&path).unwrap();
    assert_eq!(back.versions.len(), 1);
    assert_eq!(back.versions[0].canvas.width, 640);
    assert!(back.apply_version("v1").is_some());
}

// ---------- Phase 4.1: export settings + per-version text + reframe audit ----------

#[test]
fn two_versions_export_with_different_encoders() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("enc_dual");
    let red = make_clip(&dir, "r.mp4", "red", 220, 1.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 1000, 0)]));
    add_media(&mut doc, "r", &red);
    doc.versions.push(FormatVersion {
        id: "h265".into(),
        name: "h265".into(),
        preset_id: None,
        canvas: Canvas {
            width: 320,
            height: 240,
            fps_num: 24,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: Default::default(),
        export: ExportSettings {
            codec: "libx265".into(),
            preset: "ultrafast".into(),
            container: "mkv".into(),
            ..Default::default()
        },
        subtitle_style: None,
    });
    doc.versions.push(FormatVersion {
        id: "h264".into(),
        name: "h264".into(),
        preset_id: None,
        canvas: Canvas {
            width: 160,
            height: 120,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: Default::default(),
        export: ExportSettings {
            codec: "libx264".into(),
            preset: "ultrafast".into(),
            container: "mp4".into(),
            crf: 30,
            ..Default::default()
        },
        subtitle_style: None,
    });

    for (vid, want_codec, want_w, want_h) in
        [("h265", "hevc", 320u32, 240u32), ("h264", "h264", 160, 120)]
    {
        let v = doc.version(vid).unwrap();
        let merged = doc.apply_version(vid).unwrap();
        let sources = resolve_sources(&merged, None);
        let plan = plan::build_plan_with(&merged, &sources, &v.export).unwrap();
        let out = dir.join(format!("{vid}.{}", v.export.container));
        run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();
        // codec verified via ffprobe
        let meta = probe::probe(&out).unwrap();
        let (w, h, _) = probe_meta(&out);
        assert_eq!((w, h), (want_w, want_h), "{vid} dims");
        assert_eq!(meta.codec.as_deref(), Some(want_codec), "{vid} codec");
        // real file written with right container extension
        assert!(out.extension().unwrap() == v.export.container.as_str());
    }
}

#[test]
fn invalid_export_combo_rejected_not_ignored() {
    let s = ExportSettings {
        codec: "libx264".into(),
        container: "webm".into(),
        ..Default::default()
    };
    assert!(plan::validate_export(&s).is_err());
    let s2 = ExportSettings {
        codec: "libvpx-vp9".into(),
        container: "mp4".into(),
        ..Default::default()
    };
    assert!(plan::validate_export(&s2).is_err());
    let ok = ExportSettings::default();
    assert!(plan::validate_export(&ok).is_ok());
}

#[test]
fn version_text_override_independent_copy() {
    let mut doc = base_doc();
    doc.timeline.tracks.push(Track {
        id: "t".into(),
        kind: TrackKind::Text,
        name: "T1".into(),
        clips: vec![Clip {
            id: "txt".into(),
            media_ref: None,
            start_ms: 0,
            duration_ms: 1000,
            source_in_ms: 0,
            source_out_ms: None,
            source_duration_ms: None,
            transform: Transform::default(),
            effects: vec![],
            volume: 1.0,
            pan: 0.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            speed: 1.0,
            text: Some("YouTube Title".into()),
            text_style: Some(TextStyle::default()),
            keyframes: Default::default(),
            shape: None,
            text_fx: None,
            hidden: false,
            brand_bindings: None,
        }],
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    });
    let ov = ClipOverride {
        text: Some("TikTok Title".into()),
        text_style: Some(TextStyle {
            color: "#FF0000".into(),
            font_size_px: 90.0,
            ..Default::default()
        }),
        ..Default::default()
    };
    doc.versions.push(FormatVersion {
        id: "tk".into(),
        name: "tk".into(),
        preset_id: None,
        canvas: Canvas {
            width: 240,
            height: 426,
            fps_num: 30,
            fps_den: 1,
            background: "#000".into(),
        },
        safe_zones: SafeZones::default(),
        clip_overrides: [("txt".to_string(), ov)].into_iter().collect(),
        export: ExportSettings::default(),
        subtitle_style: None,
    });
    let merged = doc.apply_version("tk").unwrap();
    let c = &merged.timeline.tracks[0].clips[0];
    assert_eq!(c.text.as_deref(), Some("TikTok Title"));
    assert_eq!(c.text_style.as_ref().unwrap().color, "#FF0000");
    // base untouched
    assert_eq!(
        doc.timeline.tracks[0].clips[0].text.as_deref(),
        Some("YouTube Title")
    );
}

#[test]
fn reframe_static_scene_uses_centered_fallback() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("rf_static");
    let src = make_clip(&dir, "still.mp4", "blue", 220, 1.5);
    let samples = creatora_lib::render::reframe::analyze_motion(&src, 0, 1500, 8).unwrap();
    // Solid color → no motion; centroid should be ~center, flagged non-motion.
    assert!(samples.iter().all(|s| !s.motion || s.energy < 0.01));
    for s in &samples {
        assert!((s.cx - 0.5).abs() < 0.15, "static drifted: {}", s.cx);
    }
}

#[test]
fn reframe_subject_exit_and_reentry_holds_then_retracks() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("rf_exit");
    // Box visible only mid-window: enters ~1s, leaves ~3s.
    let src = dir.join("exit.mp4");
    let ok = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=black:size=320x240:rate=30:d=4",
            "-f",
            "lavfi",
            "-i",
            "color=white:size=40x40:rate=30:d=4",
            "-filter_complex",
            "[0:v][1:v]overlay=x=t*60:y=100:enable='between(t,1,3)'",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(ok.success());
    let samples = creatora_lib::render::reframe::analyze_motion(&src, 0, 4000, 16).unwrap();
    assert!(samples.len() >= 8);
    // After exit (t>3s ≈ sample 12+): holds last position, doesn't snap to center.
    let tail: Vec<f64> = samples
        .iter()
        .filter(|s| s.t_ms > 3300)
        .map(|s| s.cx)
        .collect();
    if tail.len() >= 2 {
        let spread = tail.iter().cloned().fold(0.0f64, f64::max)
            - tail.iter().cloned().fold(1.0f64, f64::min);
        assert!(spread < 0.2, "post-exit centroid jumped: spread {spread}");
    }
}

// ---------- Phase 5: subtitle burn-in (ADR-025) ----------

/// ASS burn-in: cue renders real pixels via libass, timing gates visibility.
#[test]
fn subtitle_burnin_shows_cue_only_in_window() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("subs");
    let a = make_clip(&dir, "a.mp4", "black", 0, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "a", 0, 4000, 0)]));
    add_media(&mut doc, "a", &a);
    doc.subtitles.push(SubtitleCue {
        id: "s1".into(),
        start_ms: 1500,
        end_ms: 3000,
        text: "HELLO".into(),
        style_id: None,
        words: vec![],
    });
    doc.subtitle_style.text.font_size_px = 40.0;
    doc.subtitle_style.text.outline_color = Some("#000000".into());
    doc.subtitle_style.text.outline_width = 0.0;

    let sources = resolve_sources(&doc, None);
    let mut plan = plan::build_plan(&doc, &sources).unwrap();
    let ass = creatora_lib::subtitles::to_ass(&doc, &doc.subtitles, &doc.subtitle_style);
    let ass_path = dir.join("t.ass");
    std::fs::write(&ass_path, ass).unwrap();
    plan.with_ass(ass_path);
    let out = dir.join("out.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();

    let before = grab_frame(&out, 0.5, 320, 240);
    let during = grab_frame(&out, 2.0, 320, 240);
    let after = grab_frame(&out, 3.5, 320, 240);
    let lit = |px: &[u8]| {
        px.chunks(3)
            .filter(|c| c[0] > 200 && c[1] > 200 && c[2] > 200)
            .count()
    };
    assert!(
        lit(&before) < 50,
        "subtitle leaked before window: {}",
        lit(&before)
    );
    assert!(
        lit(&during) > 100,
        "no subtitle pixels during cue: {}",
        lit(&during)
    );
    assert!(
        lit(&after) < 50,
        "subtitle leaked after window: {}",
        lit(&after)
    );
}

/// Karaoke mode emits \k tags → progressive fill changes highlight pixels.
#[test]
fn subtitle_karaoke_changes_highlight_color_over_time() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("karaoke");
    let a = make_clip(&dir, "a.mp4", "black", 0, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "a", 0, 4000, 0)]));
    add_media(&mut doc, "a", &a);
    doc.subtitles.push(SubtitleCue {
        id: "s1".into(),
        start_ms: 500,
        end_ms: 3500,
        text: "ONE TWO".into(),
        style_id: None,
        words: vec![
            WordTiming {
                word: "ONE".into(),
                start_ms: 500,
                end_ms: 2000,
            },
            WordTiming {
                word: " TWO".into(),
                start_ms: 2000,
                end_ms: 3500,
            },
        ],
    });
    doc.subtitle_style.mode = "karaoke".into();
    doc.subtitle_style.highlight_color = "#FF0000".into();
    doc.subtitle_style.text.font_size_px = 40.0;
    doc.subtitle_style.text.outline_width = 0.0;

    let sources = resolve_sources(&doc, None);
    let mut plan = plan::build_plan(&doc, &sources).unwrap();
    let ass = creatora_lib::subtitles::to_ass(&doc, &doc.subtitles, &doc.subtitle_style);
    let ass_path = dir.join("k.ass");
    std::fs::write(&ass_path, ass).unwrap();
    assert!(std::fs::read_to_string(&ass_path).unwrap().contains(r"\k"));
    plan.with_ass(ass_path);
    let out = dir.join("out.mp4");
    run_ffmpeg(&plan, &out, |_| {}, || false).unwrap();

    // Early: "ONE" is being karaoked — red pixels present.
    let early = grab_frame(&out, 1.0, 320, 240);
    let early_red = early
        .chunks(3)
        .filter(|c| c[0] > 150 && c[1] < 80 && c[2] < 80)
        .count();
    assert!(early_red > 30, "no karaoke fill early: {early_red}");
}

/// SRT/VTT serializers preserve timestamps + unicode.
#[test]
fn external_subtitle_exports_preserve_content() {
    use creatora_lib::subtitles::{to_srt, to_vtt};
    let cues = vec![SubtitleCue {
        id: "x".into(),
        start_ms: 1234,
        end_ms: 5678,
        text: "Hola — niño \nsecond line".into(),
        style_id: None,
        words: vec![],
    }];
    let srt = to_srt(&cues);
    assert!(srt.contains("00:00:01,234 --> 00:00:05,678"));
    assert!(srt.contains("Hola — niño "));
    let vtt = to_vtt(&cues);
    assert!(vtt.starts_with("WEBVTT"));
    assert!(vtt.contains("00:00:01.234 --> 00:00:05.678"));
    assert!(vtt.contains("second line"));
}

// ---------- Phase 6: Audio Studio (ADR-026) ----------

/// Per-channel RMS (stereo decode, 8 kHz s16 interleaved).
fn audio_rms_ch(path: &Path, from_s: f64, to_s: f64, ch: usize) -> f64 {
    let out = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            &*path.to_string_lossy(),
            "-f",
            "s16le",
            "-ac",
            "2",
            "-ar",
            "8000",
            "-",
        ])
        .output()
        .unwrap();
    assert!(out.status.success());
    let pcm = out.stdout;
    let (a, b) = ((from_s * 8000.0) as usize * 4, (to_s * 8000.0) as usize * 4);
    let (a, b) = (a.min(pcm.len()), b.min(pcm.len()));
    if b <= a + 4 {
        return 0.0;
    }
    let mut sum = 0f64;
    let mut n = 0usize;
    for i in (a..b - 3).step_by(4) {
        let s = i16::from_le_bytes([pcm[i + ch * 2], pcm[i + ch * 2 + 1]]) as f64;
        sum += s * s;
        n += 1;
    }
    (sum / n.max(1) as f64).sqrt() / 32768.0
}

fn audio_clip(id: &str, asset: &str, start_ms: i64, dur_ms: i64) -> Clip {
    clip(id, asset, start_ms, dur_ms, 0)
}

fn audio_track(id: &str, clips: Vec<Clip>) -> Track {
    let mut t = video_track(clips);
    t.id = id.into();
    t.kind = TrackKind::Audio;
    t
}

fn make_audio(dir: &Path, name: &str, spec: &str, secs: f64) -> PathBuf {
    let out = dir.join(name);
    if out.is_file() {
        return out;
    }
    let st = Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("{spec}:duration={secs}"),
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&out)
        .status()
        .unwrap();
    assert!(st.success());
    out
}

#[test]
fn audio_pan_attenuates_opposite_channel() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("pan");
    let a = make_audio(&dir, "a.wav", "sine=frequency=440", 3.0);
    let mut doc = base_doc();
    let mut c = audio_clip("c1", "a", 0, 3000);
    c.pan = -1.0; // hard left
    doc.timeline.tracks.push(audio_track("A1", vec![c]));
    add_media(&mut doc, "a", &a);
    let out = render(&dir, &doc, "out.mp4");
    let l = audio_rms_ch(&out, 0.5, 2.5, 0);
    let r = audio_rms_ch(&out, 0.5, 2.5, 1);
    assert!(l > 0.04, "left silent: {l} (r={r})");
    assert!(r < l * 0.1, "pan failed: L={l:.3} R={r:.3}");
}

#[test]
fn clip_fade_in_and_out_ramp_level() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("cfade");
    let a = make_audio(&dir, "a.wav", "sine=frequency=440", 4.0);
    let mut doc = base_doc();
    let mut c = audio_clip("c1", "a", 0, 4000);
    c.fade_in_ms = 2000;
    c.fade_out_ms = 2000;
    doc.timeline.tracks.push(audio_track("A1", vec![c]));
    add_media(&mut doc, "a", &a);
    let out = render(&dir, &doc, "out.mp4");
    let early = audio_rms(&out, 0.1, 0.6);
    let mid = audio_rms(&out, 2.0, 2.9);
    let late = audio_rms(&out, 3.4, 3.9);
    assert!(mid > 500.0, "mid silent");
    assert!(early < mid * 0.6, "no fade-in: {early:.3} vs {mid:.3}");
    assert!(late < mid * 0.6, "no fade-out: {late:.3} vs {mid:.3}");
}

#[test]
fn track_volume_and_solo_mix_correctly() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("tv");
    let a = make_audio(&dir, "a.wav", "sine=frequency=440", 3.0);
    let b = make_audio(&dir, "b.wav", "sine=frequency=880", 3.0);
    // Track volume 0.5 → RMS halves.
    let mut doc = base_doc();
    let mut t = audio_track("A1", vec![audio_clip("c1", "a", 0, 3000)]);
    t.volume = 0.5;
    doc.timeline.tracks.push(t);
    add_media(&mut doc, "a", &a);
    let out = render(&dir, &doc, "half.mp4");
    let mut doc2 = base_doc();
    doc2.timeline
        .tracks
        .push(audio_track("A1", vec![audio_clip("c1", "a", 0, 3000)]));
    add_media(&mut doc2, "a", &a);
    let out2 = render(&dir, &doc2, "full.mp4");
    let half = audio_rms(&out, 0.5, 2.5);
    let full = audio_rms(&out2, 0.5, 2.5);
    assert!(
        (half / full - 0.5).abs() < 0.1,
        "track vol: {half:.3}/{full:.3}"
    );

    // Solo: B solo → A silenced.
    let mut doc3 = base_doc();
    doc3.timeline
        .tracks
        .push(audio_track("A1", vec![audio_clip("c1", "a", 0, 3000)]));
    let mut tb = audio_track("A2", vec![audio_clip("c2", "b", 0, 3000)]);
    tb.solo = true;
    doc3.timeline.tracks.push(tb);
    add_media(&mut doc3, "a", &a);
    add_media(&mut doc3, "b", &b);
    let out3 = render(&dir, &doc3, "solo.mp4");
    // 880Hz present, 440 absent → highpass the mix: energy survives; lowpass: dies.
    let hi = {
        let p = dir.join("hp.wav");
        Command::new(ffmpeg().unwrap())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                &out3.to_string_lossy(),
                "-af",
                "highpass=f=600",
                &p.to_string_lossy(),
            ])
            .status()
            .unwrap();
        audio_rms(&p, 0.5, 2.5)
    };
    // Reference: same lowpass applied to a render of ONLY the B track.
    let mut doc4 = base_doc();
    doc4.timeline
        .tracks
        .push(audio_track("A2", vec![audio_clip("c2", "b", 0, 3000)]));
    add_media(&mut doc4, "b", &b);
    let out4 = render(&dir, &doc4, "onlyb.mp4");
    let lp_of = |src: &PathBuf, name: &str| {
        let p = dir.join(name);
        Command::new(ffmpeg().unwrap())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                &src.to_string_lossy(),
                "-af",
                "lowpass=f=300,lowpass=f=300",
                &p.to_string_lossy(),
            ])
            .status()
            .unwrap();
        audio_rms(&p, 0.5, 2.5)
    };
    let lo = lp_of(&out3, "lp.wav");
    let lo_ref = lp_of(&out4, "lpref.wav");
    // Solo output's low-band energy ≈ the 880-only reference (no 440 leak).
    assert!(hi > 500.0, "solo render silent");
    assert!(lo < lo_ref * 2.0, "solo leak: {lo:.0} vs ref {lo_ref:.0}");
}

#[test]
fn ducking_ducks_music_under_voice() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("duck");
    // Voice: 2s burst starting at 1s; music: constant.
    let voice = dir.join("voice.wav");
    Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=300:duration=2",
            "-af",
            "adelay=1000:all=1",
            "-t",
            "4",
            &voice.to_string_lossy(),
        ])
        .status()
        .unwrap();
    let music = make_audio(&dir, "music.wav", "sine=frequency=880", 4.0);

    let mk_doc = |duck: bool| {
        let mut doc = base_doc();
        doc.timeline.tracks.push(audio_track(
            "VOICE",
            vec![audio_clip("v", "voice", 0, 4000)],
        ));
        doc.timeline.tracks.push(audio_track(
            "MUSIC",
            vec![audio_clip("m", "music", 0, 4000)],
        ));
        add_media(&mut doc, "voice", &voice);
        add_media(&mut doc, "music", &music);
        if duck {
            doc.ducking.push(DuckingRule {
                id: "d1".into(),
                source_track: "VOICE".into(),
                target_track: "MUSIC".into(),
                threshold_db: -40.0,
                reduction_db: -15.0,
                attack_ms: 20.0,
                release_ms: 300.0,
                hold_ms: 100.0,
            });
        }
        doc
    };
    let out_no = render(&dir, &mk_doc(false), "noduck.mp4");
    let out_dk = render(&dir, &mk_doc(true), "duck.mp4");
    // During voice (1.5–3s) the mixed level should drop vs no-duck.
    let during_no = audio_rms(&out_no, 1.5, 2.9);
    let during_dk = audio_rms(&out_dk, 1.5, 2.9);
    // After voice ends (3.3–3.9s) both return to music-only level.
    let after_dk = audio_rms(&out_dk, 3.4, 3.95);
    let after_no = audio_rms(&out_no, 3.4, 3.95);
    assert!(
        during_dk < during_no * 0.85,
        "no ducking: {during_dk:.3} vs {during_no:.3}"
    );
    assert!(
        after_dk > after_no * 0.8,
        "release failed: {after_dk:.3} vs {after_no:.3}"
    );
}

#[test]
fn audio_fx_highpass_and_limiter_apply() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("afx");
    let a = make_audio(&dir, "a.wav", "sine=frequency=200", 3.0);
    let mut doc = base_doc();
    let mut c = audio_clip("c1", "a", 0, 3000);
    let mut params = std::collections::BTreeMap::new();
    params.insert("freq".to_string(), 800.0);
    c.effects.push(Effect {
        id: "e1".into(),
        kind: "highpass".into(),
        enabled: true,
        params,
        in_ms: None,
        out_ms: None,
        file: None,
        times: None,
    });
    doc.timeline.tracks.push(audio_track("A1", vec![c]));
    add_media(&mut doc, "a", &a);
    let out = render(&dir, &doc, "out.mp4");
    // Baseline without the filter.
    let mut doc2 = base_doc();
    doc2.timeline
        .tracks
        .push(audio_track("A1", vec![audio_clip("c1", "a", 0, 3000)]));
    add_media(&mut doc2, "a", &a);
    let out2 = render(&dir, &doc2, "base.mp4");
    let rms = audio_rms(&out, 0.5, 2.5);
    let base = audio_rms(&out2, 0.5, 2.5);
    // 200 Hz below the 800 Hz highpass → strongly attenuated.
    assert!(
        rms < base * 0.15,
        "highpass ineffective: {rms:.0} vs {base:.0}"
    );
}

#[test]
fn waveform_peaks_match_audio() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("wf");
    let a = make_audio(&dir, "a.wav", "sine=frequency=440", 2.0);
    let wf = creatora_lib::audio::waveform(&a, 100).unwrap();
    assert_eq!(wf.buckets, 100);
    assert_eq!(wf.peaks.len(), 200);
    let max_peak = wf.peaks.iter().cloned().fold(0f32, f32::max);
    assert!(max_peak > 0.05, "peaks too small: {max_peak}");
    assert!(wf.duration_ms > 1800, "duration: {}", wf.duration_ms);
}

#[test]
fn loudness_and_silence_analysis_work() {
    let Some(_ff) = ffmpeg() else { return };
    let dir = tmpdir("loud");
    let a = make_audio(&dir, "a.wav", "sine=frequency=440", 3.0);
    let l = creatora_lib::audio::loudness(&a).unwrap();
    assert!(
        l.integrated.is_finite() && l.integrated < 0.0,
        "I={}",
        l.integrated
    );
    assert!(l.true_peak <= 0.5, "tp={}", l.true_peak);

    // Silence: 1s tone, 2s silence, 1s tone.
    let gapped = dir.join("gapped.wav");
    Command::new(ffmpeg().unwrap())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-filter_complex",
            "[0][1][2]concat=n=3:v=0:a=1",
            &gapped.to_string_lossy(),
        ])
        .status()
        .unwrap();
    let regions = creatora_lib::audio::detect_silence(&gapped, -35.0, 400).unwrap();
    assert!(!regions.is_empty(), "no silence detected");
    let mid = &regions[0];
    assert!(
        mid.start_ms > 500 && mid.start_ms < 1600,
        "start={}",
        mid.start_ms
    );
    assert!(
        mid.end_ms - mid.start_ms > 1500,
        "len={}",
        mid.end_ms - mid.start_ms
    );
}

// ---------- Phase 7: graphics studio (ADR-027) ----------

fn gfx_clip(id: &str, start: i64, dur: i64) -> Clip {
    Clip {
        id: id.into(),
        media_ref: None,
        start_ms: start,
        duration_ms: dur,
        source_in_ms: 0,
        source_out_ms: None,
        source_duration_ms: None,
        transform: Transform::default(),
        effects: vec![],
        volume: 1.0,
        pan: 0.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        speed: 1.0,
        text: None,
        text_style: None,
        keyframes: Default::default(),
        shape: None,
        text_fx: None,
        hidden: false,
        brand_bindings: None,
    }
}

fn gfx_track(clips: Vec<Clip>) -> Track {
    Track {
        id: "g1".into(),
        kind: TrackKind::Graphics,
        name: "G1".into(),
        clips,
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    }
}

fn white_px(f: &[u8], w: usize, r0: usize, r1: usize, c0: usize, c1: usize) -> u64 {
    let mut n = 0;
    for row in r0..r1 {
        for col in c0..c1 {
            let i = (row * w + col) * 3;
            if f[i] > 200 && f[i + 1] > 200 && f[i + 2] > 200 {
                n += 1;
            }
        }
    }
    n
}

fn chan_px(f: &[u8], w: usize, r0: usize, r1: usize, c0: usize, c1: usize, ch: usize) -> u64 {
    let mut n = 0;
    for row in r0..r1 {
        for col in c0..c1 {
            let i = (row * w + col) * 3;
            if f[i + ch] > 200 && f[i] < 80 && f[i + 1] < 80 {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn shape_rect_renders_filled_box() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("shape");
    let red = make_clip(&dir, "r.mp4", "red", 440, 2.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 2000, 0)]));
    let mut sh = gfx_clip("shp", 0, 2000);
    sh.shape = Some(ShapeSpec {
        kind: "rect".into(),
        fill: "#0000FF".into(),
        outline_color: None,
        outline_width: 0.0,
        width_px: 160.0,
        height_px: 120.0,
    });
    doc.timeline.tracks.push(gfx_track(vec![sh]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "shape.mp4");
    let f = grab_frame(&out, 1.0, 320, 240);
    // 160x120 box centered on 320x240 → rows 60-180, cols 80-240 blue.
    assert!(
        chan_px(&f, 320, 105, 135, 130, 190, 2) > 1500,
        "blue shape missing at canvas center"
    );
    assert_eq!(
        chan_px(&f, 320, 10, 40, 10, 40, 2),
        0,
        "blue leaked outside the shape"
    );
}

#[test]
fn typewriter_grows_text_over_time() {
    if ffmpeg().is_none() {
        return;
    }
    if !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("typew");
    let red = make_clip(&dir, "r.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 4000, 0)]));
    let mut t = gfx_clip("tw", 0, 4000);
    t.text = Some("HELLO".into());
    t.text_style = Some(TextStyle {
        font_size_px: 80.0,
        color: "#FFFFFF".into(),
        align_h: "center".into(),
        align_v: "middle".into(),
        ..Default::default()
    });
    t.text_fx = Some(TextFx {
        kind: "typewriter".into(),
        rate: 2.0, // 2 chars/sec → 'H' at 0.25s, 'HELLO' at 2.5s
        direction: String::new(),
        duration_ms: 0,
        out: false,
    });
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "tw.mp4");
    // Early: ~1 char ("H") — narrow strip; late: all 5 — more white px.
    let early = white_px(&grab_frame(&out, 0.3, 320, 240), 320, 90, 150, 40, 280);
    let late = white_px(&grab_frame(&out, 3.5, 320, 240), 320, 90, 150, 40, 280);
    assert!(early > 50, "no glyph visible early (got {early})");
    assert!(
        late > early * 2,
        "typewriter didn't grow text: early={early} late={late}"
    );
}

#[test]
fn wipe_reveals_left_to_right() {
    if ffmpeg().is_none() {
        return;
    }
    if !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("wipe");
    let red = make_clip(&dir, "r.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 4000, 0)]));
    let mut t = gfx_clip("wp", 0, 4000);
    t.text = Some("WIPE".into());
    t.text_style = Some(TextStyle {
        font_size_px: 70.0,
        color: "#FFFFFF".into(),
        align_h: "center".into(),
        align_v: "middle".into(),
        ..Default::default()
    });
    t.text_fx = Some(TextFx {
        kind: "wipe".into(),
        rate: 0.0,
        direction: "ltr".into(),
        duration_ms: 2000,
        out: false,
    });
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "wipe.mp4");
    // At t=1.0 (50%): left half shows text, right half doesn't.
    let mid = grab_frame(&out, 1.0, 320, 240);
    let left = white_px(&mid, 320, 90, 150, 60, 160);
    let right = white_px(&mid, 320, 90, 150, 200, 300);
    assert!(left > 50, "wipe: left not revealed (got {left})");
    assert!(
        left > right * 4 + 20,
        "wipe: right already visible mid-reveal (l={left} r={right})"
    );
}

#[test]
fn hidden_clip_is_not_rendered() {
    if ffmpeg().is_none() {
        return;
    }
    if !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("hidden");
    let red = make_clip(&dir, "r.mp4", "red", 440, 2.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 2000, 0)]));
    let mut t = gfx_clip("hd", 0, 2000);
    t.text = Some("GHOST".into());
    t.text_style = Some(TextStyle {
        font_size_px: 80.0,
        color: "#FFFFFF".into(),
        ..Default::default()
    });
    t.hidden = true;
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "hid.mp4");
    assert_eq!(
        white_px(&grab_frame(&out, 1.0, 320, 240), 320, 0, 240, 0, 320),
        0,
        "hidden clip still rendered"
    );
}

#[test]
fn text_scale_keyframes_grow_on_canvas() {
    if ffmpeg().is_none() {
        return;
    }
    if !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("tscale");
    let red = make_clip(&dir, "r.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 4000, 0)]));
    let mut t = gfx_clip("sc", 1000, 3000); // starts at 1s — catches the
                                            // clip-relative keyframe offset
    t.text = Some("BIG".into());
    t.text_style = Some(TextStyle {
        font_size_px: 40.0,
        color: "#FFFFFF".into(),
        ..Default::default()
    });
    use creatora_lib::project::document::Keyframe;
    t.keyframes.insert(
        "transform.scaleX".into(),
        vec![
            Keyframe {
                t_ms: 0,
                v: 0.2,
                ease: "linear".into(),
                anim: None,
            },
            Keyframe {
                t_ms: 2000,
                v: 1.5,
                ease: "linear".into(),
                anim: None,
            },
        ],
    );
    t.keyframes.insert(
        "transform.scaleY".into(),
        vec![
            Keyframe {
                t_ms: 0,
                v: 0.2,
                ease: "linear".into(),
                anim: None,
            },
            Keyframe {
                t_ms: 2000,
                v: 1.5,
                ease: "linear".into(),
                anim: None,
            },
        ],
    );
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "tscale.mp4");
    // t=1.1 → scale ~0.2 (small text); t=3.8 → ~1.4 (big text).
    // Glyph coverage doesn't scale linearly in a fixed window (clipping
    // + AA), and zoompan's zoom<1 sampling differs slightly from the old
    // scale path — assert robust growth, not an exact ratio.
    let early = white_px(&grab_frame(&out, 1.2, 320, 240), 320, 60, 180, 60, 260);
    let late = white_px(&grab_frame(&out, 3.8, 320, 240), 320, 60, 180, 60, 260);
    assert!(
        late > early * 3 / 2 + 100,
        "scale kf didn't grow text: early={early} late={late}"
    );
}

#[test]
fn wipe_out_erases_at_tail() {
    if ffmpeg().is_none() || !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("wipeout");
    let red = make_clip(&dir, "r.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 4000, 0)]));
    let mut t = gfx_clip("wo", 0, 4000);
    t.text = Some("WIPE".into());
    t.text_style = Some(TextStyle {
        font_size_px: 70.0,
        color: "#FFFFFF".into(),
        align_h: "center".into(),
        align_v: "middle".into(),
        ..Default::default()
    });
    t.text_fx = Some(TextFx {
        kind: "wipe".into(),
        rate: 0.0,
        direction: "ltr".into(),
        duration_ms: 1500,
        out: true,
    });
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "wo.mp4");
    // Before the window (t=1.0): fully visible. Window = [2.5s, 4s].
    let early = white_px(&grab_frame(&out, 1.0, 320, 240), 320, 90, 150, 60, 260);
    let late = white_px(&grab_frame(&out, 3.8, 320, 240), 320, 90, 150, 60, 260);
    assert!(early > 100, "text should be visible pre-wipe-out ({early})");
    assert!(
        late < early / 5,
        "wipe-out should erase most of the text: early={early} late={late}"
    );
}

#[test]
fn blur_reveal_sharpens() {
    if ffmpeg().is_none() || !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("blurfx");
    let red = make_clip(&dir, "r.mp4", "red", 440, 4.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "r", 0, 4000, 0)]));
    let mut t = gfx_clip("bl", 0, 4000);
    t.text = Some("FOCUS".into());
    t.text_style = Some(TextStyle {
        font_size_px: 70.0,
        color: "#FFFFFF".into(),
        align_h: "center".into(),
        align_v: "middle".into(),
        ..Default::default()
    });
    t.text_fx = Some(TextFx {
        kind: "blur".into(),
        rate: 14.0,
        direction: String::new(),
        duration_ms: 2000,
        out: false,
    });
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "r", &red);
    let out = render(&dir, &doc, "blur.mp4");
    // Late: fully sharp — strong white core pixels.
    let late = white_px(&grab_frame(&out, 3.5, 320, 240), 320, 80, 160, 40, 280);
    assert!(late > 200, "sharp text missing after blur reveal ({late})");
    // Early: blurred copy only — dimmer peak coverage than sharp.
    let early = white_px(&grab_frame(&out, 0.2, 320, 240), 320, 80, 160, 40, 280);
    assert!(
        early < late,
        "blurred start should have fewer full-white px than sharp end ({early} vs {late})"
    );
}

#[test]
fn shadow_offsets_dark_pixels() {
    if ffmpeg().is_none() || !std::path::Path::new("C:/Windows/Fonts/arial.ttf").exists() {
        return;
    }
    let dir = tmpdir("shadow");
    let white = make_clip(&dir, "w.mp4", "white", 440, 2.0);
    let mut doc = base_doc();
    doc.timeline
        .tracks
        .push(video_track(vec![clip("c1", "w", 0, 2000, 0)]));
    let mut t = gfx_clip("sh", 0, 2000);
    t.text = Some("SHADOW".into());
    t.text_style = Some(TextStyle {
        font_size_px: 70.0,
        color: "#FF0000".into(),
        shadow_color: Some("#000000".into()),
        shadow_x: 30.0,
        shadow_y: 30.0,
        align_h: "center".into(),
        align_v: "middle".into(),
        ..Default::default()
    });
    doc.timeline.tracks.push(gfx_track(vec![t]));
    add_media(&mut doc, "w", &white);
    let out = render(&dir, &doc, "sh.mp4");
    let f = grab_frame(&out, 1.0, 320, 240);
    // Red text present at center (R high, G/B low — chan_px only fits blue).
    let red_px = {
        let mut n = 0u64;
        for row in 100..140 {
            for col in 120..200 {
                let i = (row * 320 + col) * 3;
                if f[i] > 200 && f[i + 1] < 80 && f[i + 2] < 80 {
                    n += 1;
                }
            }
        }
        n
    };
    assert!(red_px > 50, "red text missing ({red_px})");
    // Shadow = dark pixels offset down-right of glyphs on white bg.
    let dark = {
        let mut n = 0u64;
        for row in 130..170 {
            for col in 140..230 {
                let i = (row * 320 + col) * 3;
                if f[i] < 60 && f[i + 1] < 60 && f[i + 2] < 60 {
                    n += 1;
                }
            }
        }
        n
    };
    assert!(dark > 30, "no shadow pixels detected ({dark})");
}
