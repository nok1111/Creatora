//! Native library-transition graphs vs their SPECIFICATION, on real ffmpeg.
//!
//! The recipe `expr` in the manifest is the transition as a per-pixel
//! function. The export never runs it (too slow); it runs the native graph
//! built in `fxlib.rs`. These tests render both for the same source frames
//! and bound the difference, so the fast path can never silently drift from
//! what the preview (GLSL transpile of the same recipe) shows.

use super::fxlib::{entry, expand_text};
use super::plan::{self, SourceInfo};
use crate::project::document::*;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Test-only twin of src/lib/fx/ffmpeg-expand.ts::expandSamplers — the
/// plane dispatch `xfade=custom` needs to run the SPEC through ffmpeg.
/// `PLANE` in a recipe means channel index R,G,B,A = 0..3 (the manifest /
/// GLSL convention). `xfade=custom` runs on `gbrap`, whose planes are
/// G,B,R,A — remap the recipe's `PLANE` reads to real channel indices
/// before `expand_samplers` injects its own raw `PLANE` dispatches.
fn gbrap_plane_fix(expr: &str) -> String {
    expr.replace(
        "PLANE",
        "if(eq(PLANE,0),1,if(eq(PLANE,1),2,if(eq(PLANE,2),0,3)))",
    )
}

fn expand_samplers(expr: &str) -> String {
    fn split_args(s: &str) -> Vec<String> {
        let (mut out, mut depth, mut cur) = (Vec::new(), 0i32, String::new());
        for ch in s.chars() {
            match ch {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            if ch == ',' && depth == 0 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.push(ch);
            }
        }
        out.push(cur);
        out
    }
    let mut out = String::new();
    let b = expr.as_bytes();
    let mut i = 0;
    while i < expr.len() {
        let is_macro = (expr[i..].starts_with("SA(") || expr[i..].starts_with("SB("))
            && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_'));
        if is_macro {
            let p = if b[i + 1] == b'A' { 'a' } else { 'b' };
            let start = i + 3;
            let (mut depth, mut j) = (1, start);
            while j < expr.len() && depth > 0 {
                match b[j] {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                j += 1;
            }
            let args: Vec<String> = split_args(&expr[start..j - 1])
                .iter()
                .map(|a| expand_samplers(a))
                .collect();
            let (x, y) = (&args[0], &args[1]);
            out.push_str(&format!(
                "if(eq(PLANE,0),{p}0({x},{y}),if(eq(PLANE,1),{p}1({x},{y}),if(eq(PLANE,2),{p}2({x},{y}),{p}3({x},{y}))))"
            ));
            i = j;
        } else {
            let ch = expr[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn ffmpeg() -> Option<PathBuf> {
    crate::media::ffmpeg_path()
}

fn run(args: &[&str]) -> Result<String, String> {
    // Long graphs (fireflies' per-firefly geq sum) exceed Windows' ~32k
    // command-line limit — same fix as production run_ffmpeg: a script file.
    let mut owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let mut graph_file: Option<PathBuf> = None;
    if let Some(i) = owned.iter().position(|a| a == "-filter_complex") {
        if owned[i + 1].len() > 30000 {
            let p = std::env::temp_dir().join(format!(
                "creatora_parity_graph_{}_{}.txt",
                std::process::id(),
                owned.len()
            ));
            std::fs::write(&p, &owned[i + 1]).unwrap();
            owned[i] = "-/filter_complex".into();
            owned[i + 1] = p.to_string_lossy().into_owned();
            graph_file = Some(p);
        }
    }
    let o = crate::proc_ext::silent(ffmpeg().unwrap())
        .args(["-hide_banner", "-y"])
        .args(&owned)
        .output()
        .map_err(|e| e.to_string())?;
    if let Some(p) = graph_file {
        let _ = std::fs::remove_file(p);
    }
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    if o.status.success() {
        Ok(err)
    } else {
        Err(err)
    }
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("creatora_fx_{tag}_{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn psnr(a: &Path, b: &Path) -> f64 {
    let err = run(&[
        "-i",
        a.to_str().unwrap(),
        "-i",
        b.to_str().unwrap(),
        "-lavfi",
        "psnr",
        "-f",
        "null",
        "-",
    ])
    .unwrap();
    let tail = err.split("average:").nth(1).expect("psnr line");
    let v = tail.split_whitespace().next().unwrap();
    if v == "inf" {
        99.0
    } else {
        v.parse().unwrap()
    }
}

const FW: u32 = 320;
const FH: u32 = 180;

/// A (0–2 s) → B (1–3 s) with `kind` over 1 s on one track.
fn two_clip_doc(
    kind: &str,
    params: &[(&str, f64)],
    a: &Path,
    b: &Path,
) -> (ProjectDoc, HashMap<String, SourceInfo>) {
    let mut d = ProjectDoc::new(
        "fx",
        Canvas {
            width: FW,
            height: FH,
            fps_num: 30,
            fps_den: 1,
            background: "#000000".into(),
        },
    );
    let clip = |id: &str, mref: &str, start: i64| Clip {
        id: id.into(),
        media_ref: Some(mref.into()),
        start_ms: start,
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
        text: None,
        text_style: None,
        keyframes: Default::default(),
        shape: None,
        text_fx: None,
        hidden: false,
        brand_bindings: None,
    };
    let mut srcs = HashMap::new();
    for (id, p) in [("a", a), ("b", b)] {
        d.media_refs.push(MediaRef {
            asset_id: id.into(),
            path: p.to_string_lossy().into(),
            hash: None,
        });
        srcs.insert(
            id.to_string(),
            SourceInfo {
                path: p.to_path_buf(),
                kind: "video".into(),
                has_audio: false,
            },
        );
    }
    d.timeline.tracks.push(Track {
        id: "t1".into(),
        kind: TrackKind::Video,
        name: "V1".into(),
        clips: vec![clip("ca", "a", 0), clip("cb", "b", 1000)],
        transitions: vec![Transition {
            id: "tr".into(),
            kind: kind.into(),
            duration_ms: 1000,
            clip_a: "ca".into(),
            clip_b: "cb".into(),
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            ease: None,
        }],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    });
    (d, srcs)
}

/// One-clip doc for intro/outro effect QA: clip 0..2s with the effect
/// windowed at `win_ms` — anchored at the start for intros, the end for
/// outros (matching the bin drop wiring).
fn effect_doc(
    kind: &str,
    params: &[(&str, f64)],
    a: &Path,
    win_ms: f64,
    at_end: bool,
) -> (ProjectDoc, HashMap<String, SourceInfo>) {
    let mut d = ProjectDoc::new(
        "fx",
        Canvas { width: FW, height: FH, fps_num: 30, fps_den: 1, background: "#000000".into() },
    );
    d.media_refs.push(MediaRef { asset_id: "a".into(), path: a.to_string_lossy().into(), hash: None });
    let mut srcs = HashMap::new();
    srcs.insert("a".to_string(), SourceInfo { path: a.to_path_buf(), kind: "image".into(), has_audio: false });
    d.timeline.tracks.push(Track {
        id: "t1".into(),
        kind: TrackKind::Video,
        name: "V1".into(),
        clips: vec![Clip {
            id: "ca".into(),
            media_ref: Some("a".into()),
            start_ms: 0,
            duration_ms: 2000,
            source_in_ms: 0,
            source_out_ms: None,
            source_duration_ms: None,
            transform: Transform::default(),
            effects: vec![Effect {
                id: "ef".into(),
                kind: kind.into(),
                enabled: true,
                params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
                in_ms: at_end.then_some(2000.0 - win_ms),
                out_ms: (!at_end).then_some(win_ms),
                file: None,
                times: None,
            }],
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
        }],
        transitions: vec![],
        locked: false,
        visible: true,
        muted: false,
        volume: 1.0,
        solo: false,
    });
    (d, srcs)
}

/// Render the plan and pull frame `n` as an RGB PNG.
fn native_frame(doc: &ProjectDoc, srcs: &HashMap<String, SourceInfo>, n: u32, out: &Path) {
    let p = plan::build_plan(doc, srcs).expect("plan");
    if std::env::var("FX_DUMP").is_ok() {
        eprintln!("GRAPH {}", p.filter_complex);
        eprintln!("ARGS {:?}", p.ffmpeg_args(out));
    }
    let args = p.ffmpeg_args(out);
    // Keep the plan's inputs + graph; replace the encoder tail with a
    // single-frame PNG tap on [vout].
    let fc_at = args.iter().position(|a| a == "-filter_complex").unwrap();
    let mut a: Vec<String> = args[1..fc_at].to_vec();
    a.push("-filter_complex".into());
    a.push(format!(
        "{};[vout]select=eq(n\\,{n}),format=rgb24[sel]",
        p.filter_complex
    ));
    a.extend([
        "-map".into(),
        "[sel]".into(),
        "-frames:v".into(),
        "1".into(),
        out.to_string_lossy().into(),
    ]);
    let refs: Vec<&str> = a.iter().map(String::as_str).collect();
    run(&refs)
        .unwrap_or_else(|e| panic!("native render failed:\n{}\n--\n{}", p.filter_complex, e));
}

/// The SPEC for one frame: the recipe through real `xfade=custom` with a
/// constant progress, on the exact source frames the native path used.
fn spec_frame(
    kind: &str,
    params: &[(&str, f64)],
    a_png: &Path,
    b_png: &Path,
    u: f64,
    out: &Path,
) {
    let e = entry(kind).unwrap();
    let pm: BTreeMap<String, f64> = params.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let expr = expand_samplers(&gbrap_plane_fix(
        &expand_text(e, e.expr.as_ref().unwrap(), &pm, None, &format!("{u:.6}")).unwrap(),
    ));
    let fc = format!(
        "[0:v]format=gbrap[a];[1:v]format=gbrap[b];[a][b]xfade=transition=custom:duration=1:offset=0:expr='{expr}',format=yuv420p,format=rgb24"
    );
    run(&[
        "-loop",
        "1",
        "-framerate",
        "30",
        "-t",
        "1",
        "-i",
        a_png.to_str().unwrap(),
        "-loop",
        "1",
        "-framerate",
        "30",
        "-t",
        "1",
        "-i",
        b_png.to_str().unwrap(),
        "-filter_complex",
        &fc,
        "-frames:v",
        "1",
        out.to_str().unwrap(),
    ])
    .unwrap_or_else(|e| panic!("spec render failed: {e}"));
}

fn make_sources(dir: &Path) -> (PathBuf, PathBuf) {
    make_sources_sz(dir, FW, FH)
}

fn make_sources_sz(dir: &Path, w: u32, h: u32) -> (PathBuf, PathBuf) {
    // Smooth, deterministic content (a time-independent geq field): the
    // pipeline ends in 4:2:0, so razor-thin patterns (testsrc2) would cap
    // PSNR at ~30 dB regardless of the transition and hide real differences.
    let mk = |name: &str, src: &str| {
        let p = dir.join(name);
        run(&[
            "-f",
            "lavfi",
            "-i",
            src,
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv444p",
            p.to_str().unwrap(),
        ])
        .unwrap();
        p
    };
    let size = format!("size={w}x{h}:rate=30:duration=2");
    let k = w as f64 / FW as f64; // keep the pattern's look across sizes
    (
        mk(
            "a.mp4",
            &format!(
                "color=c=black:{size},format=gbrp,geq=r='128+100*sin(X/({k}*23))*cos(Y/({k}*17))':g='128+90*sin((X+Y)/({k}*29))':b='128+110*cos(X/({k}*31)-Y/({k}*13))'"
            ),
        ),
        mk("b.mp4", &format!("smptebars={size},gblur=sigma={}", 1.5 * k)),
    )
}

/// Frame `n` of a source mp4 as PNG.
fn src_frame(src: &Path, n: u32, out: &Path) {
    run(&[
        "-i",
        src.to_str().unwrap(),
        "-vf",
        &format!("select=eq(n\\,{n}),format=rgb24"),
        "-frames:v",
        "1",
        out.to_str().unwrap(),
    ])
    .unwrap();
}

/// Native graph vs SPEC for every library transition at several points.
/// Thresholds are measured behaviour minus margin: `strip` is the same math
/// (only tap discretisation differs); `fields` trades resolution (1/div,
/// nearest remap) for speed.
#[test]
fn native_render_matches_spec() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let dir = tmpdir("parity");
    let (a, b) = make_sources(&dir);
    let cases: &[(&str, &[(&str, f64)], f64)] = &[
        ("velocitySwipe", &[], 33.0),
        ("velocitySwipe", &[("direction", 3.0), ("blur", 0.3)], 45.0),
        ("velocitySwipe", &[("direction", 1.0), ("blur", 0.0)], 60.0),
        ("liquidMelt", &[], 33.0),
        (
            "liquidMelt",
            &[("drip", 1.0), ("wave", 0.1), ("freq", 6.0), ("wobble", 1.0)],
            33.0,
        ),
        ("inkBleed", &[], 33.0),
        ("glitchShift", &[], 30.0),
        ("tearRift", &[], 33.0),
        ("blockCascade", &[], 33.0),
        ("vortexSpin", &[], 30.0),
        ("lumeSweep", &[], 40.0),
    ];
    for (kind, params, min_psnr) in cases {
        let (doc, srcs) = two_clip_doc(kind, params, &a, &b);
        for k in [4u32, 15, 25] {
            let n = 30 + k; // transition covers frames 30..60
            let (nat, spec) = (dir.join("nat.png"), dir.join("spec.png"));
            let (fa, fb) = (dir.join("fa.png"), dir.join("fb.png"));
            native_frame(&doc, &srcs, n, &nat);
            src_frame(&a, n, &fa);
            src_frame(&b, k, &fb);
            spec_frame(kind, params, &fa, &fb, (k as f64 + 0.5) / 30.0, &spec);
            let p = psnr(&nat, &spec);
            eprintln!("{kind} {params:?} k={k}: PSNR {p:.1} dB");
            assert!(p >= *min_psnr, "{kind} {params:?} k={k}: PSNR {p:.1} < {min_psnr}");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Debug dump: native vs spec mid-transition frames for one kind.
/// `cargo test --lib lume_debug -- --ignored --nocapture`
#[test]
#[ignore]
fn lume_debug() {
    let dir = PathBuf::from("../qa/out");
    std::fs::create_dir_all(&dir).unwrap();
    let (a, b) = make_sources(&dir);
    let kind = std::env::var("FX_KIND").unwrap_or("lumeSweep".into());
    let params: Vec<(String, f64)> = std::env::var("FX_PARAMS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let mut it = kv.splitn(2, '=');
            (it.next().unwrap().to_string(), it.next().unwrap().parse().unwrap())
        })
        .collect();
    let pr: Vec<(&str, f64)> = params.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let (doc, srcs) = two_clip_doc(&kind, &pr, &a, &b);
    let k = 15u32;
    let n = 30 + k;
    let (nat, spec) = (dir.join("dbg_nat.png"), dir.join("dbg_spec.png"));
    let (fa, fb) = (dir.join("dbg_fa.png"), dir.join("dbg_fb.png"));
    native_frame(&doc, &srcs, n, &nat);
    src_frame(&a, n, &fa);
    src_frame(&b, k, &fb);
    spec_frame(&kind, &pr, &fa, &fb, (k as f64 + 0.5) / 30.0, &spec);
    {
        let e = entry(&kind).unwrap();
        let pm: BTreeMap<String, f64> = pr.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let ex = expand_samplers(&gbrap_plane_fix(
            &expand_text(e, e.expr.as_ref().unwrap(), &pm, None, "0.516667").unwrap(),
        ));
        std::fs::write(dir.join("dbg_expr.txt"), &ex).unwrap();
    }
    eprintln!("PSNR {}", psnr(&nat, &spec));
    let p = plan::build_plan(&doc, &srcs).unwrap();
    std::fs::write(dir.join("dbg_graph.fc"), &p.filter_complex).unwrap();
    let args = p.ffmpeg_args(&dir.join("x.mp4"));
    let fc_at = args.iter().position(|a| a == "-filter_complex").unwrap();
    eprintln!("INPUTS: {:?}", &args[1..fc_at]);
    // Tap the maskedmerge output (pre-glow) at the same frame.
    let mut fc2 = p.filter_complex.clone();
    let gpos = fc2.find(",format=gbrp").expect("glow field");
    let pos = fc2[..gpos].rfind(";color=c=black").expect("glow chain start");
    fc2.truncate(pos);
    fc2.push_str(";[x0_1mrg]format=rgb24[dbgout]");
    let mut a2: Vec<String> = args[1..fc_at].to_vec();
    a2.push("-filter_complex".into());
    a2.push(format!(
        "{fc2};[dbgout]select=eq(n\\,{k})[dsel];[x0_1ah][x0_1br]concat=n=2:v=1:a=0[rest]"
    ));
    a2.extend([
        "-map".into(),
        "[dsel]".into(),
        "-frames:v".into(),
        "1".into(),
        dir.join("dbg_mrg.png").to_string_lossy().into(),
        "-map".into(),
        "[rest]".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    let refs: Vec<&str> = a2.iter().map(String::as_str).collect();
    run(&refs).unwrap_or_else(|e| panic!("mrg tap failed:\n{fc2}\n{e}"));
}

/// Intro/outro effect strip: 6 frames across the window on a real image,
/// tiled for visual QA.
/// `FX_KIND=lightCurtain FX_A=../qa/kodim15.png FX_OUT=../qa/out/ef.png
///  cargo test --lib effect_frames -- --ignored --nocapture`
#[test]
#[ignore]
fn effect_frames() {
    let dir = PathBuf::from("../qa/out");
    std::fs::create_dir_all(&dir).unwrap();
    let kind = std::env::var("FX_KIND").unwrap_or("lightCurtain".into());
    let a = PathBuf::from(std::env::var("FX_A").unwrap_or("../qa/kodim15.png".into()));
    let at_end = entry(&kind).map(|e| e.category == "outro").unwrap_or(false);
    let win: f64 = std::env::var("FX_WIN").ok().and_then(|s| s.parse().ok()).unwrap_or(900.0);
    let (doc, srcs) = effect_doc(&kind, &[], &a, win, at_end);
    // Intro window 0–win ms; outro window (2 s−win)–2 s (win ≈ 900 ms:
    // intro u ≈ .07/.33/.59/.85/1.1/1.7 — outro u ≈ 0/.33/.7/.93/1/1).
    let frames: [u32; 6] = if at_end { [5, 35, 42, 48, 56, 59] } else { [2, 9, 16, 23, 30, 45] };
    let mut tiles = Vec::new();
    for (i, n) in frames.iter().enumerate() {
        let f = dir.join(format!("ef_{kind}_{i}.png"));
        native_frame(&doc, &srcs, *n, &f);
        tiles.push(f);
    }
    let out = PathBuf::from(std::env::var("FX_OUT").unwrap_or(dir.join("ef_strip.png").to_string_lossy().into()));
    let mut args: Vec<String> = Vec::new();
    for f in &tiles {
        args.extend(["-i".into(), f.to_string_lossy().into()]);
    }
    args.extend(["-lavfi".into(), format!("hstack=inputs={}", tiles.len()), out.to_string_lossy().into()]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&refs).unwrap();
    eprintln!("SHEET {}", out.display());
}

/// Frames outside the overlap are untouched, the total length is exact and
/// the chain stays frame-accurate (no drift, no dropped frames).
#[test]
fn transition_keeps_timeline_exact() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("timing");
    let (a, b) = make_sources(&dir);
    for kind in [
        "velocitySwipe",
        "liquidMelt",
        "inkBleed",
        "glitchShift",
        "tearRift",
        "blockCascade",
        "vortexSpin",
        "lumeSweep",
    ] {
        let (doc, srcs) = two_clip_doc(kind, &[], &a, &b);
        let p = plan::build_plan(&doc, &srcs).unwrap();
        let out = dir.join(format!("{kind}.mp4"));
        let args = p.ffmpeg_args(&out);
        let refs: Vec<&str> = args[1..].iter().map(String::as_str).collect();
        run(&refs).unwrap_or_else(|e| panic!("{kind}: {e}"));
        // 3 s @ 30 fps = 90 frames.
        let probe = crate::proc_ext::silent(ffmpeg().unwrap().with_file_name("ffprobe.exe"))
            .args([
                "-v",
                "error",
                "-count_frames",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=nb_read_frames",
                "-of",
                "csv=p=0",
                out.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        let frames: i64 = String::from_utf8_lossy(&probe.stdout).trim().parse().unwrap();
        assert!((frames - 90).abs() <= 1, "{kind}: {frames} frames, want 90");
        // Frame 10 (pure A) and frame 80 (pure B) must equal the sources.
        for (n, src, sn) in [(10u32, &a, 10u32), (80, &b, 50)] {
            let (nat, want) = (dir.join("n.png"), dir.join("w.png"));
            native_frame(&doc, &srcs, n, &nat);
            src_frame(src, sn, &want);
            let p = psnr(&nat, &want);
            assert!(p > 34.0, "{kind} frame {n} should be the untouched source, PSNR {p:.1}");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Render cost of each library transition vs the legacy xfade at 1080p.
/// `cargo test --lib perf_1080p -- --ignored --nocapture`
#[test]
#[ignore]
fn perf_1080p() {
    let dir = tmpdir("perf");
    let mk = |name: &str, src: &str| {
        let p = dir.join(name);
        run(&[
            "-f", "lavfi", "-i", &format!("{src}=size=1920x1080:rate=30:duration=4"),
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            p.to_str().unwrap(),
        ])
        .unwrap();
        p
    };
    let a = mk("a.mp4", "testsrc2");
    let b = mk("b.mp4", "smptebars");
    for kind in [
        "crossfade",
        "velocitySwipe",
        "liquidMelt",
        "inkBleed",
        "glitchShift",
        "tearRift",
        "blockCascade",
        "vortexSpin",
        "lumeSweep",
    ] {
        let (mut doc, srcs) = two_clip_doc(kind, &[], &a, &b);
        doc.canvas.width = 1920;
        doc.canvas.height = 1080;
        for c in &mut doc.timeline.tracks[0].clips {
            c.duration_ms = 4000;
        }
        doc.timeline.tracks[0].clips[1].start_ms = 3000;
        let p = plan::build_plan(&doc, &srcs).unwrap();
        let out = dir.join(format!("{kind}.mp4"));
        let args = p.ffmpeg_args(&out);
        let refs: Vec<&str> = args[1..].iter().map(String::as_str).collect();
        let t = std::time::Instant::now();
        run(&refs).unwrap_or_else(|e| panic!("{kind}: {e}"));
        eprintln!("PERF {kind}: {:.2}s for 7s@1080p30 (1s transition)", t.elapsed().as_secs_f64());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Visual QA: native frames across a transition, tiled left→right.
/// `FX_A`/`FX_B` = still images; `FX_KIND`, `FX_OUT` pick kind / output.
/// `cargo test --lib contact_sheet -- --ignored --nocapture`
#[test]
#[ignore]
fn contact_sheet() {
    let dir = tmpdir("sheet");
    let kind = std::env::var("FX_KIND").unwrap_or("velocitySwipe".into());
    let out = std::env::var("FX_OUT").unwrap_or("fx_sheet.png".into());
    let still = |var: &str, fallback: &str, name: &str| -> PathBuf {
        let p = dir.join(name);
        let src = std::env::var(var).unwrap_or_default();
        let input = if Path::new(&src).is_file() { vec!["-loop".to_string(), "1".into(), "-i".into(), src] } else { vec!["-f".to_string(), "lavfi".into(), "-i".into(), fallback.to_string()] };
        let mut args: Vec<&str> = input.iter().map(String::as_str).collect();
        let vf = format!("scale={FW}:{FH},setsar=1,fps=30");
        args.extend(["-t", "2", "-vf", &vf, "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv444p", p.to_str().unwrap()]);
        run(&args).unwrap();
        p
    };
    let a = still("FX_A", "testsrc2=size=320x180:rate=30", "a.mp4");
    let b = still("FX_B", "smptebars=size=320x180:rate=30", "b.mp4");
    let (doc, srcs) = two_clip_doc(&kind, &[], &a, &b);
    let p = plan::build_plan(&doc, &srcs).unwrap();
    let args = p.ffmpeg_args(&dir.join("x.png"));
    let fc_at = args.iter().position(|x| x == "-filter_complex").unwrap();
    let mut v: Vec<String> = args[1..fc_at].to_vec();
    v.push("-filter_complex".into());
    v.push(format!("{};[vout]select='eq(n,33)+eq(n,39)+eq(n,45)+eq(n,51)+eq(n,57)',format=rgb24,tile=5x1[sel]", p.filter_complex));
    v.extend(["-map".into(), "[sel]".into(), "-frames:v".into(), "1".into(), out.clone()]);
    let refs: Vec<&str> = v.iter().map(String::as_str).collect();
    run(&refs).unwrap();
    eprintln!("SHEET {out}");
}

/// The production field resolution (div 8 at 1080p) vs the SPEC. Lower than
/// the full-res test because 1/8 fields smooth the wobble — this bounds how
/// much.
#[test]
fn liquid_melt_lowres_fields_stay_close_to_spec_at_1080p() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("melt1080");
    let (a, b) = make_sources_sz(&dir, 1920, 1080);
    let (mut doc, srcs) = two_clip_doc("liquidMelt", &[], &a, &b);
    doc.canvas.width = 1920;
    doc.canvas.height = 1080;
    for k in [10u32, 15, 22] {
        let n = 30 + k;
        let (nat, spec) = (dir.join("nat.png"), dir.join("spec.png"));
        let (fa, fb) = (dir.join("fa.png"), dir.join("fb.png"));
        native_frame(&doc, &srcs, n, &nat);
        src_frame(&a, n, &fa);
        src_frame(&b, k, &fb);
        spec_frame("liquidMelt", &[], &fa, &fb, (k as f64 + 0.5) / 30.0, &spec);
        let p = psnr(&nat, &spec);
        eprintln!("liquidMelt 1080p k={k}: PSNR {p:.1} dB");
        assert!(p >= 24.0, "liquidMelt 1080p k={k}: PSNR {p:.1}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ── library effects (RGB displacement / Hero Entrance / Beat Impact) ───

fn effect(id: &str, kind: &str, params: &[(&str, f64)], times: Option<Vec<f64>>) -> Effect {
    Effect {
        id: id.into(),
        kind: kind.into(),
        enabled: true,
        params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        in_ms: None,
        out_ms: None,
        file: None,
        times,
    }
}

/// 2 s clip: mid-gray (100) with a centred 40×40 white box.
fn box_source(dir: &Path) -> PathBuf {
    let p = dir.join("box.mp4");
    run(&[
        "-f",
        "lavfi",
        "-i",
        &format!(
            "color=c=0x646464:s={FW}x{FH}:r=30:d=2,drawbox=x={}:y={}:w=40:h=40:c=white:t=fill",
            FW / 2 - 20,
            FH / 2 - 20
        ),
        "-c:v",
        "libx264",
        "-crf",
        "0",
        "-pix_fmt",
        "yuv444p",
        p.to_str().unwrap(),
    ])
    .unwrap();
    p
}

fn one_clip_doc(src: &Path, effects: Vec<Effect>) -> (ProjectDoc, HashMap<String, SourceInfo>) {
    let (mut doc, mut srcs) = two_clip_doc("crossfade", &[], src, src);
    doc.timeline.tracks[0].transitions.clear();
    doc.timeline.tracks[0].clips.truncate(1);
    doc.timeline.tracks[0].clips[0].effects = effects;
    srcs.retain(|k, _| k == "a");
    doc.media_refs.retain(|m| m.asset_id == "a");
    (doc, srcs)
}

/// RGB bytes (w*h*3) of frame `n` of the plan's output.
fn raw_frame(doc: &ProjectDoc, srcs: &HashMap<String, SourceInfo>, n: u32) -> Vec<u8> {
    let p = plan::build_plan(doc, srcs).expect("plan");
    let args = p.ffmpeg_args(Path::new("x.png"));
    let fc_at = args.iter().position(|a| a == "-filter_complex").unwrap();
    let mut a: Vec<String> = args[1..fc_at].to_vec();
    a.push("-filter_complex".into());
    a.push(format!("{};[vout]select=eq(n\\,{n}),format=rgb24[sel]", p.filter_complex));
    a.extend(["-map", "[sel]", "-frames:v", "1", "-f", "rawvideo", "-"].map(String::from));
    let o = crate::proc_ext::silent(ffmpeg().unwrap())
        .args(["-hide_banner", "-v", "error", "-y"])
        .args(&a)
        .output()
        .unwrap();
    assert!(o.status.success(), "render failed:\n{}\n{}", p.filter_complex, String::from_utf8_lossy(&o.stderr));
    o.stdout
}

/// x-span (min,max) of pixels where channel `ch` > `thr` on row `y`.
fn span(rgb: &[u8], ch: usize, y: u32, thr: u8) -> Option<(u32, u32)> {
    let xs: Vec<u32> = (0..FW).filter(|x| rgb[((y * FW + x) * 3) as usize + ch] > thr).collect();
    Some((*xs.first()?, *xs.last()?))
}

fn px(rgb: &[u8], x: u32, y: u32) -> [u8; 3] {
    let i = ((y * FW + x) * 3) as usize;
    [rgb[i], rgb[i + 1], rgb[i + 2]]
}

#[test]
fn rgb_displacement_shifts_red_right_and_blue_left_by_the_shared_formula() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("rgbd");
    let src = box_source(&dir);
    let (doc, srcs) = one_clip_doc(
        &src,
        vec![effect("e1", "rgbDisplacement", &[("mode", 0.0), ("amount", 1.2), ("angle", 0.0)], None)],
    );
    let f = raw_frame(&doc, &srcs, 10);
    let want = super::fxeffects::rgb_shift(1.2, 0.0, 1.0, FW as f64).0 as u32; // 1.2% of 320 → 4
    let y = FH / 2;
    // white box: G stays at 140..180 (centred), R moves right, B moves left.
    let (g0, g1) = span(&f, 1, y, 200).unwrap();
    let (r0, r1) = span(&f, 0, y, 200).unwrap();
    let (b0, b1) = span(&f, 2, y, 200).unwrap();
    assert_eq!((r0 - g0, r1 - g1), (want, want), "red must move right by {want}px");
    assert_eq!((g0 - b0, g1 - b1), (want, want), "blue must move left by {want}px");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hero_entrance_matches_the_shared_curves() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("hero");
    let src = box_source(&dir);
    let p = [("duration", 900.0), ("zoom", 0.3), ("flash", 0.5), ("split", 0.0)];
    let (doc, srcs) = one_clip_doc(&src, vec![effect("h1", "heroEntrance", &p, None)]);
    let y = FH / 2;
    for n in [0u32, 6, 12] {
        let f = raw_frame(&doc, &srcs, n);
        let t = n as f64 / 30.0;
        // zoom: white box width = 40·scale
        let scale = 1.0 + 0.3 * super::fxeffects::expo_decay(t / 0.9);
        let (g0, g1) = span(&f, 1, y, 200).unwrap_or((0, 0));
        // flash lifts the gray background by eq brightness·255/219·255
        let b = 0.6 * 0.5 * (1.0f64 - (t / 0.9).min(1.0) / 0.35).max(0.0).powi(2);
        let want_bg = (100.0 + b * 255.0 * 255.0 / 219.0).min(255.0);
        let bg = px(&f, 5, 5)[1] as f64;
        let w = (g1 - g0 + 1) as f64;
        eprintln!("hero n={n}: box {w:.0}px (want {:.1}), bg {bg} (want {want_bg:.0})", 40.0 * scale);
        assert!((w - 40.0 * scale).abs() <= 2.5, "n={n}: width {w} vs {:.1}", 40.0 * scale);
        assert!((bg - want_bg).abs() <= 4.0, "n={n}: bg {bg} vs {want_bg:.0}");
    }
    // After the entrance everything is back to the source.
    let f = raw_frame(&doc, &srcs, 40);
    let (g0, g1) = span(&f, 1, y, 200).unwrap();
    assert_eq!(g1 - g0 + 1, 40);
    assert!((px(&f, 5, 5)[1] as i32 - 100).abs() <= 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn beat_impact_pulses_on_each_beat_and_relaxes() {
    if ffmpeg().is_none() {
        return;
    }
    let dir = tmpdir("beat");
    let src = box_source(&dir);
    // beats at 500 ms and 1200 ms of the source
    let p = [("zoom", 0.2), ("flash", 0.0), ("decay", 8.0)];
    let (doc, srcs) = one_clip_doc(&src, vec![effect("b1", "beatImpact", &p, Some(vec![500.0, 1200.0]))]);
    let y = FH / 2;
    let width_at = |n: u32| {
        let f = raw_frame(&doc, &srcs, n);
        let (g0, g1) = span(&f, 1, y, 200).unwrap();
        (g1 - g0 + 1) as f64
    };
    // before any beat: untouched
    assert_eq!(width_at(5), 40.0);
    // on the beat (n=15 ⇒ t=0.5): full punch 1.2×
    assert!((width_at(15) - 48.0).abs() <= 2.5, "{}", width_at(15));
    // 0.25 s later it has decayed: 1+0.2·e^(-8·0.25)=1.027
    let w = width_at(22);
    assert!(w > 40.0 && w < 44.0, "{w}");
    // second beat re-punches
    assert!((width_at(36) - 48.0).abs() <= 2.5, "{}", width_at(36));
    let _ = std::fs::remove_dir_all(&dir);
}

/// The 100+-beat case must stay under the argv limit through a graph file.
#[test]
fn long_graphs_are_moved_to_a_file() {
    use super::commands::{externalize_filter_graph, MAX_INLINE_GRAPH};
    let mut args: Vec<String> = vec!["-i".into(), "x".into(), "-filter_complex".into(), "a".repeat(MAX_INLINE_GRAPH + 1)];
    let guard = externalize_filter_graph(&mut args).expect("externalised");
    assert_eq!(args[2], "-/filter_complex");
    assert_eq!(std::fs::read_to_string(&args[3]).unwrap().len(), MAX_INLINE_GRAPH + 1);
    let path = guard.0.clone();
    drop(guard);
    assert!(!path.exists(), "temp graph file must be cleaned up");
    let mut short: Vec<String> = vec!["-filter_complex".into(), "a".into()];
    assert!(externalize_filter_graph(&mut short).is_none());
}

/// Attach `chain` (a `-vf`-style graph with possible `;` sub-graphs) to the
/// command as `-filter_complex '[0:v]chain[vout]'` + `-map [vout]`, moving it
/// to a temp script file when it would exceed the argv limit — same rule the
/// production runner applies (some light geq fields are >16 kB).
fn push_chain(c: &mut Command, chain: &str) -> Option<super::commands::TempGraphFile> {
    let mut args = vec![
        "-filter_complex".to_string(),
        format!("[0:v]{chain}[vout]"),
    ];
    let guard = super::commands::externalize_filter_graph(&mut args);
    c.args(&args);
    c.args(["-map", "[vout]"]);
    guard
}

/// Filter thumbnails: run the REAL production fragment chain (fxeffects::
/// fragments → the same string export embeds in the filtergraph) on the
/// shared photographic sample and write shared/fx/thumbs/<id>.png.
///   cargo test --lib render::fxlib_parity::filter_thumbs -- --ignored
#[test]
#[ignore]
fn filter_thumbs() {
    use crate::project::document::Effect;
    use std::collections::BTreeMap;
    let Some(ff) = ffmpeg() else {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let out_dir = root.join("shared/fx/thumbs");
    std::fs::create_dir_all(&out_dir).unwrap();
    for entry in crate::render::fxlib::manifest().entries.iter().filter(|e| e.kind == "filter") {
        let fx = Effect {
            id: "thumbfx1".into(),
            kind: entry.id.clone(),
            enabled: true,
            in_ms: None,
            out_ms: None,
            file: None,
            times: None,
            params: BTreeMap::new(),
        };
        let frags = crate::render::fxeffects::fragments(&fx, &crate::render::fxeffects::FxCtx::default())
            .unwrap_or_default()
            .join(",");
        // FX_THUMB_SCALE: larger renders reveal resolution-scaled stages
        // (bloom/soft radii are relative to frame size, not thumb size).
        let scale: u32 = std::env::var("FX_THUMB_SCALE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(384);
        let chain = if frags.is_empty() {
            format!("scale={scale}:-2")
        } else {
            format!("{frags},scale={scale}:-2")
        };
        let out = out_dir.join(format!("{}.png", entry.id));
        let st = crate::proc_ext::silent(&ff)
            .args(["-hide_banner", "-y", "-i"])
            .arg(&sample)
            .args(["-vf", &chain, "-frames:v", "1", "-update", "1"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(st.success(), "thumb render failed for {}", entry.id);
        eprintln!("thumb: {}", entry.id);
    }
}

/// Filter batch verification through the real production chain:
/// intensity=0 ≈ identity, stacked filters compose, aspect-agnostic.
///   cargo test --lib render::fxlib_parity::filter_verify -- --ignored
#[test]
#[ignore]
fn filter_verify() {
    use crate::project::document::Effect;
    let Some(ff) = ffmpeg() else {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let tmp = std::env::temp_dir().join("creatora-fxverify");
    std::fs::create_dir_all(&tmp).unwrap();

    let frags_for = |id: &str, params: &[(&str, f64)]| -> String {
        let fx = Effect {
            id: "v".into(),
            kind: id.into(),
            enabled: true,
            in_ms: None,
            out_ms: None,
            file: None,
            times: None,
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        };
        crate::render::fxeffects::fragments(&fx, &crate::render::fxeffects::FxCtx::default())
            .unwrap_or_default()
            .join(",")
    };
    let render = |chain: &str, name: &str| -> PathBuf {
        let out = tmp.join(name);
        let st = crate::proc_ext::silent(&ff)
            .args(["-hide_banner", "-v", "error", "-y", "-i"])
            .arg(&sample)
            .args(["-vf", chain, "-frames:v", "1", "-update", "1"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(st.success(), "render failed: {name}\n{chain}");
        out
    };
    let raw = |p: &Path| -> Vec<u8> {
        crate::proc_ext::silent(&ff)
            .args(["-hide_banner", "-v", "error", "-y", "-i"])
            .arg(p)
            .args(["-vf", "scale=320:-2,format=rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap()
            .stdout
    };
    let mean_diff = |a: &Path, b: &Path| -> f64 {
        let (a, b) = (raw(a), raw(b));
        a.iter()
            .zip(b.iter())
            .map(|(x, y)| (*x as f64 - *y as f64).abs())
            .sum::<f64>()
            / a.len().max(1) as f64
    };

    // 1) intensity=0 → near-identity (LUT mixes to identity, spatials scale
    //    to 0 — the chain may legitimately emit no fragments at all)
    let i0 = frags_for("goldenFilm", &[("intensity", 0.0)]);
    let a = render(
        &if i0.is_empty() { "scale=320:-2".into() } else { format!("{i0},scale=320:-2") },
        "i0.png",
    );
    let d = mean_diff(&a, &sample);
    eprintln!("intensity=0 mean|Δ| = {d:.2} (frags: {})", i0.split(',').filter(|s| !s.is_empty()).count());
    assert!(d < 4.0, "intensity=0 must be near-identity, got {d}");

    // 2) stacked filters compose (goldenFilm → dreamy)
    let f1 = frags_for("goldenFilm", &[]);
    let f2 = frags_for("dreamy", &[]);
    let single = render(&format!("{f1},scale=320:-2"), "single.png");
    let stack = render(&format!("{f1},{f2},scale=320:-2"), "stack.png");
    let dd = mean_diff(&single, &stack);
    eprintln!("stack vs single mean|Δ| = {dd:.2}");
    assert!(dd > 1.0, "stacked filters must change output, got {dd}");

    // 3) aspect-agnostic: 9:16 + 1:1 crops render cleanly through the chain
    for (name, crop) in [("v916", "crop=iw*9/16:ih"), ("sq", "crop=ih:ih")] {
        let out = render(&format!("{crop},{f1},scale=240:-2"), &format!("ar_{name}.png"));
        assert!(out.exists());
    }
    eprintln!("filter_verify ok");
}

// ── Light & Atmosphere effects (kind:"effect", preview:"gl") ─────────

/// Effect-strip thumbnails: run the REAL fragment chain on the shared
/// photographic sample, grab 8 frames across ~1.5 s and tile them into
/// shared/fx/thumbs/<id>.png — the Effects Bin plays the strip with a
/// CSS steps() animation, so tiles match export frames exactly.
///   cargo test --lib render::fxlib_parity::light_thumbs -- --ignored
#[test]
#[ignore]
fn light_thumbs() {
    use crate::project::document::Effect;
    let Some(ff) = ffmpeg() else {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let out_dir = root.join("shared/fx/thumbs");
    std::fs::create_dir_all(&out_dir).unwrap();
    let (tw, th) = (384u32, 216u32);
    let sel = (0..8).map(|k| format!("eq(n\\,{})", 6 + k * 5)).collect::<Vec<_>>().join("+");
    for entry in crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "effect" && e.category == "light")
    {
        let fx = Effect {
            id: "thumbfx1".into(),
            kind: entry.id.clone(),
            enabled: true,
            in_ms: None,
            out_ms: None,
            file: None,
            times: None,
            params: Default::default(),
        };
        let frags = crate::render::fxeffects::fragments(
            &fx,
            &crate::render::fxeffects::FxCtx {
                w: tw,
                h: th,
                fps_num: 30,
                fps_den: 1,
                clip_ms: 3000,
                source_in_ms: 0,
                speed: 1.0,
            },
        )
        .unwrap_or_default()
        .join(";");
        let chain = format!("scale={tw}:{th},setsar=1,{frags},select='{sel}',tile=8x1");
        let out = out_dir.join(format!("{}.png", entry.id));
        let mut c = crate::proc_ext::silent(&ff);
        c.args(["-hide_banner", "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "3", "-i"])
            .arg(&sample);
        let _g = push_chain(&mut c, &chain);
        c.args(["-frames:v", "1", "-update", "1"]).arg(&out);
        let st = c.status().unwrap();
        assert!(st.success(), "light thumb failed for {}\n{chain}", entry.id);
        eprintln!("light thumb: {}", entry.id);
    }
}

/// Light-effect verification through the real chain: each effect must
/// visibly change the sample (non-identity) and render across a clip,
/// not just at t=0.
///   cargo test --lib render::fxlib_parity::light_verify -- --ignored
#[test]
#[ignore]
fn light_verify() {
    use crate::project::document::Effect;
    let Some(ff) = ffmpeg() else {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let tmp = std::env::temp_dir().join("creatora-lightverify");
    std::fs::create_dir_all(&tmp).unwrap();
    let ctx = crate::render::fxeffects::FxCtx {
        w: 384,
        h: 216,
        fps_num: 30,
        fps_den: 1,
        clip_ms: 3000,
        source_in_ms: 0,
        speed: 1.0,
    };
    let raw = |p: &Path| -> Vec<u8> {
        crate::proc_ext::silent(&ff)
            .args(["-hide_banner", "-v", "error", "-y", "-i"])
            .arg(p)
            .args(["-vf", "format=rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap()
            .stdout
    };
    let base = raw(&{
        let b = tmp.join("base.png");
        crate::proc_ext::silent(&ff)
            .args(["-hide_banner", "-v", "error", "-y", "-i"])
            .arg(&sample)
            .args(["-vf", "scale=384:216", "-frames:v", "1", "-update", "1"])
            .arg(&b)
            .status()
            .unwrap();
        b
    });
    let mean = |a: &[u8], b: &[u8]| {
        a.iter().zip(b.iter()).map(|(x, y)| (*x as f64 - *y as f64).abs()).sum::<f64>() / a.len() as f64
    };
    for entry in crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "effect" && e.category == "light")
    {
        let fx = Effect {
            id: "v".into(),
            kind: entry.id.clone(),
            enabled: true,
            in_ms: None,
            out_ms: None,
            file: None,
            times: None,
            params: Default::default(),
        };
        let frags = crate::render::fxeffects::fragments(&fx, &ctx).unwrap_or_default().join(";");
        // frames 20 and 60 — the animation must be live at both
        let mut last = 0.0;
        for n in [20u32, 60] {
            let out = tmp.join(format!("{}_{n}.png", entry.id));
            let chain = format!("scale=384:216,setsar=1,{frags},select=eq(n\\,{n})");
            let mut c = crate::proc_ext::silent(&ff);
            c.args(["-hide_banner", "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "3", "-i"])
                .arg(&sample);
            let _g = push_chain(&mut c, &chain);
            c.args(["-frames:v", "1", "-update", "1"]).arg(&out);
            let st = c.status().unwrap();
            assert!(st.success(), "{}: render failed\n{chain}", entry.id);
            let a = raw(&out);
            let d = mean(&a, &base);
            let mx = a.iter().zip(base.iter()).map(|(x, y)| (*x as i32 - *y as i32).abs()).max().unwrap_or(0);
            eprintln!("{} n={n}: mean|Δ| = {d:.2}  max|Δ| = {mx}", entry.id);
            assert!(mx > 45, "{}: frame {n} not visibly affected (maxΔ {mx})", entry.id);
            last = d;
        }
        let _ = last;
    }
    eprintln!("light_verify ok");
}

/// Debug: write the generated fragment chain for one light effect to
/// qa/out/frag_<id>.txt for manual ffmpeg runs.
///   cargo test --lib render::fxlib_parity::light_dump -- --ignored
#[test]
#[ignore]
fn light_dump() {
    use crate::project::document::Effect;
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let out_dir = root.join("qa/out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let ctx = crate::render::fxeffects::FxCtx {
        w: 1280, h: 720, fps_num: 30, fps_den: 1, clip_ms: 3000, source_in_ms: 0, speed: 1.0,
    };
    for entry in crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "effect" && e.category == "light")
    {
        let fx = Effect {
            id: "v".into(), kind: entry.id.clone(), enabled: true,
            in_ms: None, out_ms: None, file: None, times: None,
            params: Default::default(),
        };
        let frags = crate::render::fxeffects::fragments(&fx, &ctx).unwrap_or_default().join(";");
        let chain = format!("scale=1280:720,setsar=1,{frags},select=eq(n\\,30)");
        std::fs::write(out_dir.join(format!("frag_{}.txt", entry.id)), &chain).unwrap();
        eprintln!("dumped {}", entry.id);
    }
}

/// Dumps cinematicFog chains for all three `pattern` values so the
/// Ground/Rolling/Haze variants can be rendered and compared.
///   cargo test --lib render::fxlib_parity::light_fog_patterns -- --ignored
#[test]
#[ignore]
fn light_fog_patterns() {
    use crate::project::document::Effect;
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let out_dir = root.join("qa/out");
    let ctx = crate::render::fxeffects::FxCtx {
        w: 1280, h: 720, fps_num: 30, fps_den: 1, clip_ms: 3000, source_in_ms: 0, speed: 1.0,
    };
    for pat in 0..3 {
        let fx = Effect {
            id: "v".into(), kind: "cinematicFog".into(), enabled: true,
            in_ms: None, out_ms: None, file: None, times: None,
            params: [("pattern".to_string(), pat as f64)].into_iter().collect(),
        };
        let frags = crate::render::fxeffects::fragments(&fx, &ctx).unwrap_or_default().join(";");
        let chain = format!("scale=1280:720,setsar=1,{frags},select=eq(n\\,30)");
        std::fs::write(out_dir.join(format!("frag_fog_p{pat}.txt")), &chain).unwrap();
        eprintln!("dumped fog pattern {pat}");
    }
}

/// Full-res (1280×720) production frames for visual QA of the light
/// collection — one PNG per effect at t=1 s on the photographic sample.
///   cargo test --lib render::fxlib_parity::light_frames -- --ignored
#[test]
#[ignore]
fn light_frames() {
    use crate::project::document::Effect;
    let Some(ff) = ffmpeg() else {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let out_dir = root.join("qa/out/light_frames");
    std::fs::create_dir_all(&out_dir).unwrap();
    let ctx = crate::render::fxeffects::FxCtx {
        w: 1280, h: 720, fps_num: 30, fps_den: 1, clip_ms: 3000, source_in_ms: 0, speed: 1.0,
    };
    for entry in crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "effect" && e.category == "light")
    {
        let fx = Effect {
            id: "v".into(), kind: entry.id.clone(), enabled: true,
            in_ms: None, out_ms: None, file: None, times: None,
            params: Default::default(),
        };
        let frags = crate::render::fxeffects::fragments(&fx, &ctx).unwrap_or_default().join(";");
        let chain = format!("scale=1280:720,setsar=1,{frags},select=eq(n\\,30)");
        let out = out_dir.join(format!("{}.png", entry.id));
        let mut c = crate::proc_ext::silent(&ff);
        c.args(["-hide_banner", "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "2", "-i"])
            .arg(&sample);
        let _g = push_chain(&mut c, &chain);
        c.args(["-frames:v", "1", "-update", "1"]).arg(&out);
        assert!(c.status().unwrap().success(), "frame failed for {}", entry.id);
        eprintln!("frame: {}", entry.id);
    }
}

/// Multi-scene sheet for the light collection: rows = Original + 4 effects,
/// cols = base / dark / night / bright variants of the QA sample. Same
/// production chain, same frame — the visual review target for Batch 1.
///   cargo test --lib render::fxlib_parity::light_scenes -- --ignored
#[test]
#[ignore]
fn light_scenes() {
    use crate::project::document::Effect;
    let Some(ff) = ffmpeg() else {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let out_dir = root.join("qa/out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let tmp = std::env::temp_dir().join("creatora-lightscenes");
    std::fs::create_dir_all(&tmp).unwrap();
    let ctx = crate::render::fxeffects::FxCtx {
        w: 384, h: 216, fps_num: 30, fps_den: 1, clip_ms: 3000, source_in_ms: 0, speed: 1.0,
    };
    // scene grades: base, dark room, blue night, blown bright
    let scenes = [
        ("base", "null"),
        ("dark", "eq=brightness=-0.28:saturation=0.85"),
        ("night", "eq=brightness=-0.42:saturation=0.55,colorbalance=bm=0.3:bs=0.35"),
        ("bright", "eq=brightness=0.22:saturation=0.8"),
    ];
    let mut rows: Vec<String> = vec!["Original".to_string()];
    rows.extend(crate::render::fxlib::manifest()
        .entries.iter()
        .filter(|e| e.kind == "effect" && e.category == "light")
        .map(|e| e.id.clone()));
    let mut cells: Vec<Vec<String>> = Vec::new();
    for (ri, row) in rows.iter().enumerate() {
        let mut cells_row = Vec::new();
        for (scene, grade) in &scenes {
            let cell = tmp.join(format!("s_{ri}_{scene}.png"));
            let frags = if ri == 0 {
                String::new()
            } else {
                let fx = Effect {
                    id: "v".into(), kind: row.clone(), enabled: true,
                    in_ms: None, out_ms: None, file: None, times: None,
                    params: Default::default(),
                };
                let f = crate::render::fxeffects::fragments(&fx, &ctx).unwrap_or_default().join(";");
                format!("{f},")
            };
            let chain = format!("scale=384:216,setsar=1,{grade},format=rgb24,{frags}format=rgb24,select=eq(n\\,30)");
            let mut c = crate::proc_ext::silent(&ff);
            c.args(["-hide_banner", "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "2", "-i"])
                .arg(&sample);
            let _g = push_chain(&mut c, &chain);
            c.args(["-frames:v", "1", "-update", "1"]).arg(&cell);
            let st = c.status().unwrap();
            assert!(st.success(), "scene cell {row}/{scene} failed\n{chain}");
            cells_row.push(cell.to_string_lossy().into_owned());
        }
        cells.push(cells_row);
    }
    // assemble: 5 rows x 4 cols via one ffmpeg run, drawtext labels
    let mut cmd = crate::proc_ext::silent(&ff);
    cmd.args(["-hide_banner", "-v", "error", "-y"]);
    for r in &cells {
        for c in r {
            cmd.args(["-i", c]);
        }
    }
    let cols = scenes.len();
    let mut fc = String::new();
    for (ri, r) in cells.iter().enumerate() {
        for (ci, _) in r.iter().enumerate() {
            let idx = ri * cols + ci;
            let label = if ci == 0 { rows[ri].as_str() } else { "" };
            fc.push_str(&format!("[{idx}:v]drawtext=text='{label} {scene}':x=6:y=6:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4[c{idx}];", scene = scenes[ci].0));
        }
    }
    for (ri, _) in cells.iter().enumerate() {
        for (ci, _) in scenes.iter().enumerate() {
            fc.push_str(&format!("[c{}]", ri * cols + ci));
        }
        fc.push_str(&format!("xstack=inputs={cols}:layout=0_0|384_0|768_0|1152_0[r{ri}];"));
    }
    for (ri, _) in cells.iter().enumerate() {
        fc.push_str(&format!("[r{ri}]"));
    }
    fc.push_str(&format!("vstack=inputs={n}[vout]", n = cells.len()));
    // versioned name — a previous sheet may be open in a viewer (Windows lock)
    let mut n = 2;
    let mut out = out_dir.join("light_comparison.png");
    let usable = |p: &Path| !p.exists() || std::fs::OpenOptions::new().write(true).open(p).is_ok();
    while !usable(&out) && n < 10 {
        out = out_dir.join(format!("light_comparison_v{n}.png"));
        n += 1;
    }
    let st = cmd
        .args(["-filter_complex", &fc, "-map", "[vout]", "-frames:v", "1", "-update", "1"])
        .arg(&out)
        .status()
        .unwrap();
    assert!(st.success(), "sheet assembly failed\n{fc}");
    eprintln!("light sheet → {}", out.display());
}

/// Bin strip thumbnails for every transition & intro/outro tile: render
/// the REAL production plan (fields engine for manifest effects, native
/// xfades for legacy merge tiles) on crops of the photographic sample,
/// select 8 frames across the gesture and tile 8x1 into
/// shared/fx/thumbs/<id>.png — the bin plays them as `.fxstrip`, so
/// tiles show actual export frames instead of CSS approximations.
///   cargo test --lib render::fxlib_parity::fx_thumbs -- --ignored --nocapture
#[test]
#[ignore]
fn fx_thumbs() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let out_dir = root.join("shared/fx/thumbs");
    std::fs::create_dir_all(&out_dir).unwrap();
    let tmp = tmpdir("fxthumbs");
    let (tw, th) = (384u32, 216u32);

    // A/B sources = different crops of the same 1536×496 panorama sample,
    // so transition tiles read as two distinct scenes.
    let a_img = tmp.join("a.png");
    let b_img = tmp.join("b.png");
    run(&["-i", sample.to_str().unwrap(), "-vf", &format!("crop={tw}:{th}:60:60"),
          "-frames:v", "1", "-update", "1", a_img.to_str().unwrap()]).unwrap();
    run(&["-i", sample.to_str().unwrap(), "-vf", &format!("crop={tw}:{th}:1050:160"),
          "-frames:v", "1", "-update", "1", b_img.to_str().unwrap()]).unwrap();
    let a_mp4 = tmp.join("a.mp4");
    let b_mp4 = tmp.join("b.mp4");
    for (img, mp4) in [(&a_img, &a_mp4), (&b_img, &b_mp4)] {
        run(&["-loop", "1", "-t", "4", "-i", img.to_str().unwrap(),
              "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
              mp4.to_str().unwrap()]).unwrap();
    }

    // One plan render per tile: select 8 frames, tile into a strip.
    let tap = |doc: &ProjectDoc, srcs: &HashMap<String, SourceInfo>, frames: &[u32], out: &Path| {
        let p = plan::build_plan(doc, srcs).expect("plan");
        let sel = frames.iter().map(|n| format!("eq(n\\,{n})")).collect::<Vec<_>>().join("+");
        let args = p.ffmpeg_args(out);
        let fc_at = args.iter().position(|a| a == "-filter_complex").unwrap();
        let mut a: Vec<String> = args[1..fc_at].to_vec();
        a.push("-filter_complex".into());
        a.push(format!("{};[vout]select='{sel}',format=rgb24,tile=8x1[sel]", p.filter_complex));
        a.extend(["-map".into(), "[sel]".into(), "-frames:v".into(), "1".into(), out.to_string_lossy().into()]);
        let refs: Vec<&str> = a.iter().map(String::as_str).collect();
        run(&refs).unwrap_or_else(|e| panic!("thumb render failed:\n{e}"));
    };

    // Intro/outro: 8 samples across the effect's own `duration` window.
    let us: [f64; 8] = [0.02, 0.16, 0.30, 0.44, 0.58, 0.72, 0.86, 0.97];
    for entry in crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "effect" && (e.category == "intro" || e.category == "outro"))
    {
        let win = entry.params.iter().find(|p| p.key == "duration").map(|p| p.def).unwrap_or(900.0);
        let at_end = entry.category == "outro";
        let (mut doc, srcs) = effect_doc(&entry.id, &[], &a_img, win, at_end);
        doc.canvas.width = tw;
        doc.canvas.height = th;
        let wf = win * 30.0 / 1000.0;
        let base = if at_end { 60.0 - wf } else { 0.0 };
        let frames: Vec<u32> = us.iter().map(|u| (base + u * wf).round() as u32).collect();
        let out = out_dir.join(format!("{}.png", entry.id));
        tap(&doc, &srcs, &frames, &out);
        eprintln!("thumb {} ({})", entry.id, entry.category);
    }

    // Merge: 8 manifest transitions + the 12 curated legacy xfades.
    // two_clip_doc puts the 1 s join at frames 30–60 of a 90-frame
    // timeline — sample the gesture across it.
    let mut kinds: Vec<String> = crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "transition")
        .map(|e| e.id.clone())
        .collect();
    if let Ok(only) = std::env::var("TR_KIND") {
        kinds.retain(|k| k == &only);
    }
    let tr_frames: [u32; 8] = [30, 34, 38, 42, 46, 50, 54, 59];
    for kind in &kinds {
        let (mut doc, srcs) = two_clip_doc(kind, &[], &a_mp4, &b_mp4);
        doc.canvas.width = tw;
        doc.canvas.height = th;
        let out = out_dir.join(format!("{kind}.png"));
        tap(&doc, &srcs, &tr_frames, &out);
        eprintln!("thumb {kind} (transition)");
    }
    let _ = std::fs::remove_dir_all(&tmp);
    eprintln!("fx thumbs → {}", out_dir.display());
}

/// Merge-transition visual audit: 16 frames per transition in an 8x2
/// sheet — row 1 covers boundary-in + first half of the gesture, row 2
/// the second half + boundary-out + post-transition frames. Catches end
/// glitches (snap/pop right at the last mixed frame) that the 8-frame
/// thumb strips skip.
///   cargo test --lib render::fxlib_parity::transition_audit -- --ignored --nocapture
#[test]
#[ignore]
fn transition_audit() {
    if ffmpeg().is_none() {
        eprintln!("skipping: ffmpeg unavailable");
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let sample = root.join("shared/fx/sample.png");
    let out_dir = root.join("qa/out/transitions");
    std::fs::create_dir_all(&out_dir).unwrap();
    let tmp = tmpdir("traudit");
    let (tw, th, a_mp4, b_mp4) = if std::env::var("TR_FOOTAGE").is_ok() {
        // Real moving footage — warp/parallax/flash defects that still
        // frames hide become visible. TR_SRC_A/TR_SRC_B override the
        // sources (e.g. frame-counter clips for temporal audits).
        let pick = |var: &str, def: &str| {
            std::env::var(var)
                .map(|p| {
                    let p = PathBuf::from(p);
                    if p.is_absolute() { p } else { root.join(p) }
                })
                .unwrap_or_else(|_| root.join(def))
        };
        (480u32, 270u32,
         pick("TR_SRC_A", "qa/media/clipA.mp4"),
         pick("TR_SRC_B", "qa/media/clipB.mp4"))
    } else {
        let (tw, th) = (384u32, 216u32);
        let a_img = tmp.join("a.png");
        let b_img = tmp.join("b.png");
        run(&["-i", sample.to_str().unwrap(), "-vf", &format!("crop={tw}:{th}:60:60"),
              "-frames:v", "1", "-update", "1", a_img.to_str().unwrap()]).unwrap();
        run(&["-i", sample.to_str().unwrap(), "-vf", &format!("crop={tw}:{th}:1050:160"),
              "-frames:v", "1", "-update", "1", b_img.to_str().unwrap()]).unwrap();
        let a_mp4 = tmp.join("a.mp4");
        let b_mp4 = tmp.join("b.mp4");
        for (img, mp4) in [(&a_img, &a_mp4), (&b_img, &b_mp4)] {
            run(&["-loop", "1", "-t", "4", "-i", img.to_str().unwrap(),
                  "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
                  mp4.to_str().unwrap()]).unwrap();
        }
        (tw, th, a_mp4, b_mp4)
    };

    let mut kinds: Vec<String> = crate::render::fxlib::manifest()
        .entries
        .iter()
        .filter(|e| e.kind == "transition")
        .map(|e| e.id.clone())
        .collect();
    if let Ok(only) = std::env::var("TR_KIND") {
        kinds.retain(|k| k == &only);
    }

    // Join at frames 30–60 of a 90-frame timeline.
    // Row 1: 29 (pure A), 30 (boundary-in), then across the gesture.
    // Row 2: 57–59 (last mixed frames), 60 (boundary-out), 61–62 (pure B).
    let frames: [u32; 16] = if std::env::var("TR_TAIL").is_ok() {
        // Dense tail: every frame from 48 → 62 to inspect continuity.
        [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]
    } else {
        [29, 30, 32, 35, 38, 41, 44, 47,
         50, 53, 55, 57, 58, 59, 60, 62]
    };
    for kind in &kinds {
        let (mut doc, srcs) = two_clip_doc(kind, &[], &a_mp4, &b_mp4);
        doc.canvas.width = tw;
        doc.canvas.height = th;
        let out = out_dir.join(if std::env::var("TR_FOOTAGE").is_ok() {
            format!("faudit_{kind}.png")
        } else {
            format!("audit_{kind}.png")
        });
        let p = plan::build_plan(&doc, &srcs).expect("plan");
        let sel = frames.iter().map(|n| format!("eq(n\\,{n})")).collect::<Vec<_>>().join("+");
        let args = p.ffmpeg_args(&out);
        let fc_at = args.iter().position(|a| a == "-filter_complex").unwrap();
        let mut a: Vec<String> = args[1..fc_at].to_vec();
        a.push("-filter_complex".into());
        a.push(format!("{};[vout]select='{sel}',format=rgb24,tile=8x2[sel]", p.filter_complex));
        a.extend(["-map".into(), "[sel]".into(), "-frames:v".into(), "1".into(), out.to_string_lossy().into()]);
        let refs: Vec<&str> = a.iter().map(String::as_str).collect();
        run(&refs).unwrap_or_else(|e| panic!("audit render failed for {kind}:\n{e}"));
        eprintln!("audit {kind}");
    }
    eprintln!("transition audit → {}", out_dir.display());
}
