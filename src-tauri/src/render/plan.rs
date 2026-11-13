//! Compile a `ProjectDoc` timeline into an ffmpeg command plan.
//!
//! Model (ADR-015): every clip becomes an independent segment placed at an
//! absolute timeline position — video via `overlay … enable='between(t,s,e)'`
//! over a `color` base, audio via `adelay` into `amix`. Sequential, gapped,
//! reordered and overlapping clips are handled identically, and the same
//! `start_ms` drives both the video gate and the audio delay, so A/V sync is
//! structural rather than adjusted.
//!
//! Time: persisted ms → ffmpeg seconds via `ms/1000` (%.3f). Frame snapping
//! happens in the editing ops; the renderer quantizes by frame selection.

use crate::error::AppError;
use crate::project::document::{Clip, ProjectDoc, TrackKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// What the plan needs to know about a referenced media file.
/// Resolved by the caller (catalog row → probe fallback) so `build_plan`
/// stays a pure function over the document.
#[derive(Debug, Clone)]
pub struct SourceInfo {
    pub path: PathBuf,
    /// "video" | "audio" | "image"
    pub kind: String,
    pub has_audio: bool,
}

/// One renderable clip, flattened out of the track tree.
#[derive(Debug, Clone)]
pub struct Segment {
    pub clip_id: String,
    /// Index into `inputs` (one input per segment — duplicates allowed).
    pub input: usize,
    /// Z-order among overlay segments: lower = further back.
    pub z_order: usize,
    /// Track array index — transition grouping happens per track.
    pub track_index: usize,
    pub start_ms: i64,
    pub duration_ms: i64,
    /// Source-media offset where playback begins.
    pub source_in_ms: i64,
    /// Source range consumed = duration_ms * speed (speed > 0).
    pub speed: f64,
    pub volume: f32,
    /// Canvas-relative transform.
    pub transform: crate::project::document::Transform,
    /// Ordered effect stack (canonical params — render/effects.rs).
    pub effects: Vec<crate::project::document::Effect>,
    /// Keyframed props: path → samples (clip-relative ms).
    pub keyframes: std::collections::BTreeMap<String, Vec<crate::project::document::Keyframe>>,
    pub source: SourceInfo,
    pub visual: bool,
    pub audible: bool,
}

#[derive(Debug)]
pub struct RenderPlan {
    pub width: u32,
    pub height: u32,
    pub fps: String, // "30000/1001" — exact rational for ffmpeg
    pub duration_ms: i64,
    pub inputs: Vec<PathBuf>,
    /// Whether each input is an image (needs `-loop 1 -t dur`).
    pub input_is_image: Vec<bool>,
    pub segments: Vec<Segment>,
    pub filter_complex: String,
    pub has_audio: bool,
}

fn ms_to_s(ms: i64) -> String {
    format!("{:.3}", ms.max(0) as f64 / 1000.0)
}

/// Number of digits after '-' used in filter labels — keeps labels unique.
fn lbl(prefix: &str, i: usize) -> String {
    format!("[{prefix}{i}]")
}

/// Flatten the doc into segments. Track array order = stacking order
/// (index 0 renders bottom-most). `visible=false` video tracks and
/// `muted` tracks are honored; text/graphics tracks are skipped (Phase 3
/// renders video/audio/image only).
fn collect_segments(
    doc: &ProjectDoc,
    sources: &HashMap<String, SourceInfo>,
) -> Result<Vec<Segment>, AppError> {
    let mut segments = Vec::new();
    let mut missing: Vec<String> = Vec::new();

    for (track_index, track) in doc.timeline.tracks.iter().enumerate() {
        let is_video_track = matches!(track.kind, TrackKind::Video | TrackKind::Image);
        let is_audio_track = track.kind == TrackKind::Audio;
        if !is_video_track && !is_audio_track {
            continue;
        }
        for clip in &track.clips {
            if clip.duration_ms <= 0 {
                continue;
            }
            let Some(media_ref) = &clip.media_ref else {
                continue;
            };
            let Some(src) = sources.get(media_ref.as_str()).or_else(|| {
                doc.media_refs
                    .iter()
                    .find(|m| &m.asset_id == media_ref)
                    .and_then(|m| sources.get(&m.path))
            }) else {
                missing.push(media_ref.clone());
                continue;
            };
            let visual =
                is_video_track && track.visible && matches!(src.kind.as_str(), "video" | "image");
            let audible = src.has_audio && !track.muted && (is_audio_track || is_video_track);
            if !visual && !audible {
                continue;
            }
            segments.push(Segment {
                clip_id: clip.id.clone(),
                input: 0, // assigned later
                z_order: 0,
                track_index,
                start_ms: clip.start_ms.max(0),
                duration_ms: clip.duration_ms,
                source_in_ms: clip.source_in_ms.max(0),
                speed: if clip.speed > 0.0 {
                    clip.speed as f64
                } else {
                    1.0
                },
                volume: clip.volume.clamp(0.0, 8.0),
                transform: clip.transform,
                effects: clip.effects.clone(),
                keyframes: clip.keyframes.clone(),
                source: src.clone(),
                visual,
                audible,
            });
        }
    }

    if segments.is_empty() {
        if missing.is_empty() {
            return Err(AppError::InvalidInput(
                "timeline has nothing to export".into(),
            ));
        }
        return Err(AppError::InvalidInput(format!(
            "all clips reference missing media ({})",
            missing.join(", ")
        )));
    }
    // Missing media on *some* clips is tolerated: those clips are skipped and
    // logged upstream — the render still reflects every resolvable clip.
    if !missing.is_empty() {
        log::warn!("render: skipping clips with unresolved media: {missing:?}");
    }
    Ok(segments)
}

/// Transition kind for the xfade whose *incoming* clip is `clip_b`.
fn group_kind<'a>(doc: &'a ProjectDoc, clip_b_id: &'a str) -> &'a str {
    doc.timeline
        .tracks
        .iter()
        .flat_map(|t| &t.transitions)
        .find(|tr| tr.clip_b == clip_b_id)
        .map(|tr| tr.kind.as_str())
        .unwrap_or("crossfade")
}

fn xfade_name(kind: &str) -> &'static str {
    match kind {
        "dipToBlack" => "fadeblack",
        "dipToWhite" => "fadewhite",
        _ => "fade", // "crossfade" and unknown kinds → linear alpha blend
    }
}

/// `atempo` accepts 0.5–2.0 per stage — chain stages for larger factors.
fn atempo_chain(speed: f64) -> String {
    let mut s = speed;
    let mut chain = Vec::new();
    while s > 2.0 {
        chain.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        chain.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    chain.push(format!("atempo={s}"));
    chain.join(",")
}

/// Per-clip video chain: trim → speed → fit/crop/transform/effects → alpha.
/// `pad_canvas` adds the transparent WxH normalization required by xfade
/// inputs (transition groups only). Ends in label `[vN]`.
fn video_chain(seg: &Segment, i: usize, doc: &ProjectDoc, pad_canvas: bool) -> String {
    use crate::render::{effects, keyframes as kf};
    let (w, h) = (doc.canvas.width, doc.canvas.height);
    let src_end_ms = seg.source_in_ms + (seg.duration_ms as f64 * seg.speed) as i64;
    let mut c = format!(
        "[{}:v]trim=start={s}:end={e},setpts=(PTS-STARTPTS)/{sp}",
        seg.input,
        s = ms_to_s(seg.source_in_ms),
        e = ms_to_s(src_end_ms),
        sp = seg.speed,
    );
    // Normalize to project rate and rgba.
    c.push_str(",fps=");
    c.push_str(&fps_string(doc));
    c.push_str(",format=rgba");
    // Fit into canvas preserving AR — no pad needed outside transitions:
    // overlay centers the box, identical to the preview's `clipRect` math.
    c.push_str(&format!(
        ",scale=w={w}:h={h}:force_original_aspect_ratio=decrease:flags=lanczos"
    ));
    // Crop fractions of the fitted box, applied before transform scale.
    let t = &seg.transform;
    let cl = t.crop_left.clamp(0.0, 0.95);
    let cr = t.crop_right.clamp(0.0, 0.95);
    let ct = t.crop_top.clamp(0.0, 0.95);
    let cb = t.crop_bottom.clamp(0.0, 0.95);
    if cl + cr + ct + cb > 0.0 {
        c.push_str(&format!(
            ",crop=w=iw*(1-{cl}-{cr}):h=ih*(1-{ct}-{cb}):x=iw*{cl}:y=ih*{ct}"
        ));
    }
    // Transform scale — static or keyframed (eval=frame on clip-relative t).
    let kx = seg.keyframes.get("transform.scaleX");
    let ky = seg.keyframes.get("transform.scaleY");
    if kx.is_some() || ky.is_some() {
        let ex = kx
            .map(|k| kf::expr(k, 0.0, t.scale_x as f64))
            .unwrap_or_else(|| format!("{}", t.scale_x));
        let ey = ky
            .map(|k| kf::expr(k, 0.0, t.scale_y as f64))
            .unwrap_or_else(|| format!("{}", t.scale_y));
        c.push_str(&format!(
            ",scale=w='iw*({ex})':h='ih*({ey})':eval=frame:flags=lanczos"
        ));
    } else if t.scale_x != 1.0 || t.scale_y != 1.0 {
        c.push_str(&format!(
            ",scale=w=iw*{}:h=ih*{}:flags=lanczos",
            t.scale_x, t.scale_y
        ));
    }
    let kr = seg.keyframes.get("transform.rotationDeg");
    if kr.is_some() || t.rotation_deg != 0.0 {
        let a = kr
            .map(|k| format!("({})*PI/180", kf::expr(k, 0.0, t.rotation_deg as f64)))
            .unwrap_or_else(|| format!("{}*PI/180", t.rotation_deg));
        c.push_str(&format!(
            ",rotate=a='{a}':fillcolor=none:ow=rotw(iw):oh=roth(ih)"
        ));
    }
    // Ordered effect stack (canonical params — same math as preview CSS).
    let fx = effects::effects_chain(&seg.effects);
    if !fx.is_empty() {
        c.push(',');
        c.push_str(&fx);
    }
    // Opacity — static via colorchannelmixer; keyframed via geq alpha expr.
    let ko = seg.keyframes.get("transform.opacity");
    if let Some(k) = ko {
        let e = kf::expr_var(k, 0.0, t.opacity as f64, 'T');
        c.push_str(&format!(
            ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({e})'"
        ));
    } else if t.opacity < 1.0 {
        c.push_str(&format!(",colorchannelmixer=aa={}", t.opacity));
    }
    if pad_canvas {
        c.push_str(&format!(
            ",pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1"
        ));
    }
    c.push_str(&lbl("v", i + 1));
    c
}

fn fps_string(doc: &ProjectDoc) -> String {
    format!("{}/{}", doc.canvas.fps_num, doc.canvas.fps_den)
}

/// Overlay position: centered on canvas + pixel offset (same math as the
/// preview's CSS placement — parity asserted by e2e tests). Keyframed x/y
/// become per-frame expressions in absolute timeline seconds.
fn overlay_xy(seg: &Segment) -> (String, String) {
    use crate::render::keyframes as kf;
    let t = &seg.transform;
    let clip_s = seg.start_ms as f64 / 1000.0;
    let x = seg
        .keyframes
        .get("transform.x")
        .map(|k| kf::expr(k, clip_s, t.x as f64))
        .unwrap_or_else(|| format!("{}", t.x));
    let y = seg
        .keyframes
        .get("transform.y")
        .map(|k| kf::expr(k, clip_s, t.y as f64))
        .unwrap_or_else(|| format!("{}", t.y));
    (
        format!("(main_w-overlay_w)/2+({x})"),
        format!("(main_h-overlay_h)/2+({y})"),
    )
}

/// A maximal run of transition-linked clips on one track.
struct Group {
    /// Indices into `segments`, ordered by timeline position.
    members: Vec<usize>,
    /// Fade durations between consecutive members (len = members - 1).
    fades: Vec<i64>,
}

/// Group each track's visual segments by its `transitions` table.
/// A clip belongs to at most one group edge per side; non-linked clips are
/// left ungrouped (plain overlay path).
fn build_groups(doc: &ProjectDoc, segments: &[Segment]) -> Vec<Group> {
    use std::collections::HashSet;
    let mut groups: Vec<Group> = Vec::new();
    let mut claimed: HashSet<usize> = HashSet::new();
    for (ti, track) in doc.timeline.tracks.iter().enumerate() {
        // seg index per clip id on this track
        let idx_of = |cid: &str| -> Option<usize> {
            segments
                .iter()
                .position(|s| s.track_index == ti && s.clip_id == cid)
        };
        for tr in &track.transitions {
            let (Some(ia), Some(ib)) = (idx_of(&tr.clip_a), idx_of(&tr.clip_b)) else {
                continue;
            };
            if !segments[ia].visual || !segments[ib].visual {
                continue;
            }
            // Overlap actually present? clamp duration to the overlap window.
            let overlap = segments[ia].start_ms + segments[ia].duration_ms - segments[ib].start_ms;
            let d = tr.duration_ms.min(overlap).max(1);
            // Try to extend an existing group ending at ia.
            if let Some(g) = groups.iter_mut().find(|g| g.members.last() == Some(&ia)) {
                g.members.push(ib);
                g.fades.push(d);
            } else if claimed.contains(&ia) || claimed.contains(&ib) {
                continue;
            } else {
                groups.push(Group {
                    members: vec![ia, ib],
                    fades: vec![d],
                });
            }
            claimed.insert(ia);
            claimed.insert(ib);
        }
    }
    // Only multi-member groups need the xfade path.
    groups.retain(|g| g.members.len() > 1);
    groups
}

/// Build the full render plan for `doc`. `sources` maps *either* asset id or
/// absolute path → SourceInfo, letting tests bypass the catalog.
pub fn build_plan(
    doc: &ProjectDoc,
    sources: &HashMap<String, SourceInfo>,
) -> Result<RenderPlan, AppError> {
    let mut segments = collect_segments(doc, sources)?;
    let groups = build_groups(doc, &segments);
    let mut in_group = std::collections::HashSet::new();
    for g in &groups {
        for &i in &g.members {
            in_group.insert(i);
        }
    }

    // One ffmpeg input per segment (simple, robust); z-order for visual
    // segments = track order (track index 0 renders bottom-most).
    let mut inputs: Vec<PathBuf> = Vec::new();
    let mut input_is_image: Vec<bool> = Vec::new();
    let mut z = 0usize;
    for (i, seg) in segments.iter_mut().enumerate() {
        seg.input = i + 1; // input 0 is the lavfi base
        inputs.push(seg.source.path.clone());
        input_is_image.push(seg.source.kind == "image");
        if seg.visual {
            seg.z_order = z;
            z += 1;
        }
    }

    let duration_ms = segments
        .iter()
        .map(|s| s.start_ms + s.duration_ms)
        .max()
        .unwrap_or(0);
    if duration_ms <= 0 {
        return Err(AppError::InvalidInput("empty timeline".into()));
    }

    let mut filters: Vec<String> = Vec::new();
    let mut cur = "[0:v]".to_string(); // base color stream
    let mut audio_labels: Vec<String> = Vec::new();

    let mut overlay_idx = 0usize;
    let mut group_idx = 0usize;
    let mut processed = std::collections::HashSet::new();

    // Audio chain helper — atrim/asetpts/atempo/volume(+kf)/afade/adelay.
    // Fades implement transition audio parity with the video crossfade.
    let audio_chain = |seg: &Segment, fade_in: i64, fade_out: i64| -> String {
        let src_end_ms = seg.source_in_ms + (seg.duration_ms as f64 * seg.speed) as i64;
        let mut c = format!(
            "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS",
            seg.input,
            ms_to_s(seg.source_in_ms),
            ms_to_s(src_end_ms)
        );
        if seg.speed != 1.0 {
            c.push(',');
            c.push_str(&atempo_chain(seg.speed));
        }
        if let Some(k) = seg.keyframes.get("volume") {
            c.push_str(&format!(
                ",volume='{}':eval=frame",
                crate::render::keyframes::expr(k, 0.0, seg.volume as f64)
            ));
        } else if seg.volume != 1.0 {
            c.push_str(&format!(",volume={}", seg.volume));
        }
        if fade_in > 0 {
            c.push_str(&format!(",afade=t=in:st=0:d={}", ms_to_s(fade_in)));
        }
        if fade_out > 0 {
            let st = seg.duration_ms - fade_out;
            c.push_str(&format!(
                ",afade=t=out:st={}:d={}",
                ms_to_s(st),
                ms_to_s(fade_out)
            ));
        }
        if seg.start_ms > 0 {
            c.push_str(&format!(",adelay={}:all=1", seg.start_ms));
        }
        c
    };

    // Fade windows per segment (from its group, if any).
    let mut fade_in = std::collections::HashMap::<usize, i64>::new();
    let mut fade_out = std::collections::HashMap::<usize, i64>::new();
    for g in &groups {
        for (j, &m) in g.members.iter().enumerate() {
            if j > 0 {
                fade_in.insert(m, g.fades[j - 1]);
            }
            if j < g.fades.len() {
                fade_out.insert(m, g.fades[j]);
            }
        }
    }

    for (i, seg) in segments.iter().enumerate() {
        if processed.contains(&i) {
            continue;
        }
        if seg.visual && !in_group.contains(&i) {
            filters.push(video_chain(seg, i, doc, false));
            let (x, y) = overlay_xy(seg);
            let start_s = ms_to_s(seg.start_ms);
            let end_s = ms_to_s(seg.start_ms + seg.duration_ms);
            let out_lbl = lbl("o", overlay_idx + 1);
            filters.push(format!(
                "{cur}{}overlay={x}:{y}:enable='between(t,{start_s},{end_s})'{out_lbl}",
                lbl("v", i + 1)
            ));
            cur = out_lbl;
            overlay_idx += 1;
        }
        if seg.visual && in_group.contains(&i) {
            // Emit the whole group the first time we reach its first member.
            if let Some(g) = groups.iter().find(|g| g.members.first() == Some(&i)) {
                for &m in &g.members {
                    filters.push(video_chain(&segments[m], m, doc, true));
                    processed.insert(m);
                }
                // Chain xfades: combined runs at group_start on the canvas.
                let mut comb = lbl("v", g.members[0] + 1);
                let mut acc_ms = segments[g.members[0]].duration_ms;
                for j in 1..g.members.len() {
                    let m = g.members[j];
                    let d = g.fades[j - 1];
                    let offset = acc_ms - d;
                    let out = lbl("g", group_idx * 16 + j);
                    filters.push(format!(
                        "{comb}{}xfade=transition={}:duration={}:offset={}{out}",
                        lbl("v", m + 1),
                        xfade_name(group_kind(doc, &segments[m].clip_id)),
                        ms_to_s(d),
                        ms_to_s(offset)
                    ));
                    comb = out;
                    acc_ms += segments[m].duration_ms - d;
                }
                let gs = segments[g.members[0]].start_ms;
                let ge = gs + acc_ms;
                let out_lbl = lbl("o", overlay_idx + 1);
                filters.push(format!(
                    "{cur}{comb}overlay=0:0:enable='between(t,{},{})'{out_lbl}",
                    ms_to_s(gs),
                    ms_to_s(ge)
                ));
                cur = out_lbl;
                overlay_idx += 1;
                group_idx += 1;
            }
        }
        if seg.audible {
            let c = audio_chain(
                seg,
                *fade_in.get(&i).unwrap_or(&0),
                *fade_out.get(&i).unwrap_or(&0),
            );
            let a_lbl = lbl("a", i + 1);
            let mut c = c;
            c.push_str(&a_lbl);
            filters.push(c);
            audio_labels.push(a_lbl);
        }
    }

    filters.push(format!("{cur}format=yuv420p[vout]"));
    let has_audio = !audio_labels.is_empty();
    if has_audio {
        filters.push(format!(
            "{}amix=inputs={}:normalize=0:duration=longest[aout]",
            audio_labels.concat(),
            audio_labels.len()
        ));
    }

    Ok(RenderPlan {
        width: doc.canvas.width,
        height: doc.canvas.height,
        fps: fps_string(doc),
        duration_ms,
        inputs,
        input_is_image,
        segments,
        filter_complex: filters.join(";"),
        has_audio,
    })
}

/// Public so commands/tests can reuse it.
pub fn find_clip<'a>(doc: &'a ProjectDoc, clip_id: &str) -> Option<&'a Clip> {
    doc.timeline
        .tracks
        .iter()
        .flat_map(|t| &t.clips)
        .find(|c| c.id == clip_id)
}

impl RenderPlan {
    /// Full argv for `ffmpeg … out`. Caller adds `-progress`/`nostdin`.
    pub fn ffmpeg_args(&self, out: &Path) -> Vec<String> {
        let dur_s = ms_to_s(self.duration_ms);
        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            dur_s.clone(),
            "-i".into(),
            format!(
                "color=c={}:s={}x{}:r={}",
                "black", self.width, self.height, self.fps
            ),
        ];
        for (i, p) in self.inputs.iter().enumerate() {
            if self.input_is_image[i] {
                let seg = &self.segments[i];
                args.extend([
                    "-loop".into(),
                    "1".into(),
                    "-framerate".into(),
                    self.fps.clone(),
                    "-t".into(),
                    ms_to_s(seg.duration_ms + seg.source_in_ms),
                ]);
            }
            args.push("-i".into());
            args.push(p.to_string_lossy().into_owned());
        }
        args.push("-filter_complex".into());
        args.push(self.filter_complex.clone());
        args.extend(["-map".into(), "[vout]".into()]);
        if self.has_audio {
            args.extend(["-map".into(), "[aout]".into()]);
        }
        args.extend([
            "-r".into(),
            self.fps.clone(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "18".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
        if self.has_audio {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        }
        args.extend([
            "-t".into(),
            dur_s,
            "-movflags".into(),
            "+faststart".into(),
            out.to_string_lossy().into_owned(),
        ]);
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::document::*;

    fn doc_with_clip(
        start: i64,
        dur: i64,
        src_in: i64,
    ) -> (ProjectDoc, HashMap<String, SourceInfo>) {
        let mut d = ProjectDoc::new(
            "t",
            Canvas {
                width: 320,
                height: 240,
                fps_num: 30,
                fps_den: 1,
                background: "#000000".into(),
            },
        );
        d.media_refs.push(MediaRef {
            asset_id: "a1".into(),
            path: "/media/a.mp4".into(),
            hash: None,
        });
        d.timeline.tracks.push(Track {
            id: "t1".into(),
            kind: TrackKind::Video,
            name: "V1".into(),
            clips: vec![Clip {
                id: "c1".into(),
                media_ref: Some("a1".into()),
                start_ms: start,
                duration_ms: dur,
                source_in_ms: src_in,
                source_out_ms: None,
                transform: Transform::default(),
                effects: vec![],
                volume: 1.0,
                speed: 1.0,
                text: None,
                keyframes: Default::default(),
            }],
            transitions: vec![],
            locked: false,
            visible: true,
            muted: false,
        });
        let mut srcs = HashMap::new();
        srcs.insert(
            "a1".to_string(),
            SourceInfo {
                path: PathBuf::from("/media/a.mp4"),
                kind: "video".into(),
                has_audio: true,
            },
        );
        (d, srcs)
    }

    #[test]
    fn empty_timeline_is_an_error() {
        let d = ProjectDoc::new(
            "e",
            Canvas {
                width: 1,
                height: 1,
                fps_num: 30,
                fps_den: 1,
                background: "#000".into(),
            },
        );
        assert!(build_plan(&d, &HashMap::new()).is_err());
    }

    #[test]
    fn plan_duration_covers_clip_end() {
        let (d, s) = doc_with_clip(1500, 2000, 500);
        let p = build_plan(&d, &s).unwrap();
        assert_eq!(p.duration_ms, 3500);
        assert!(p.filter_complex.contains("between(t,1.500,3.500)"));
        assert!(p.filter_complex.contains("atrim=start=0.500:end=2.500"));
        assert!(p.filter_complex.contains("adelay=1500"));
    }

    #[test]
    fn muted_track_drops_audio_only() {
        let (mut d, s) = doc_with_clip(0, 1000, 0);
        d.timeline.tracks[0].muted = true;
        let p = build_plan(&d, &s).unwrap();
        assert!(p.filter_complex.contains("overlay"));
        assert!(!p.has_audio);
    }

    #[test]
    fn hidden_track_drops_video_only() {
        let (mut d, s) = doc_with_clip(0, 1000, 0);
        d.timeline.tracks[0].visible = false;
        let p = build_plan(&d, &s).unwrap();
        assert!(!p.filter_complex.contains("overlay"));
        assert!(p.has_audio);
    }

    #[test]
    fn transform_scale_reaches_graph() {
        let (mut d, s) = doc_with_clip(0, 1000, 0);
        let t = &mut d.timeline.tracks[0].clips[0].transform;
        t.scale_x = 0.5;
        t.x = 40.0;
        let p = build_plan(&d, &s).unwrap();
        assert!(p.filter_complex.contains("scale=w=iw*0.5:h=ih*1"));
        assert!(p.filter_complex.contains("(main_w-overlay_w)/2+(40)"));
    }

    #[test]
    fn args_have_inputs_and_maps() {
        let (d, s) = doc_with_clip(0, 1000, 0);
        let p = build_plan(&d, &s).unwrap();
        let args = p.ffmpeg_args(Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("color=c=black:s=320x240:r=30/1"));
        assert!(joined.contains("-map [vout]"));
        assert!(joined.contains("-map [aout]"));
        assert!(joined.contains("libx264"));
    }
}
