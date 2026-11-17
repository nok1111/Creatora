import { describe, expect, it } from "vitest";
import {
  activeClipsAt,
  addClip,
  addEffect,
  addTrack,
  addTransition,
  setTransitionDuration,
  clipRect,
  diagnoseCues,
  findReplaceCues,
  fixOverlaps,
  mergeCueWithNext,
  setVersionSubtitleStyle,
  shiftAllCues,
  splitCue,
  duplicateClips,
  extractClips,
  findClip,
  frameToMs,
  moveClip,
  moveClips,
  moveClipToTrack,
  moveTrackOrder,
  msToFrame,
  pasteClips,
  removeClip,
  removeClips,
  removeEffect,
  removeKeyframe,
  removeTrack,
  removeTransition,
  renameTrack,
  setKeyframe,
  setTrackFlag,
  snapToFrame,
  splitClip,
  timecode,
  timelineDuration,
  transitionAlpha,
  trimClip,
  updateClip,
  updateEffect,
  applyVersion,
  addTextClip,
  addVersion,
  setVersionClipOverride,
  duplicateVersion,
  resetVersion,
  removeVersion,
  upsertDuckingRule,
  removeDuckingRule,
  applySilenceCut,
  addGeneratedClip,
  applyAnimationPreset,
  applyClipStyle,
  retimeClipKeyframes,
  alignClipTo,
  bindClipBrand,
  applyBrandToBoundClips,
  clearVersionClipOverrides,
  clipStylePayload,
  setDocBrandKit,
} from "@/lib/timeline-engine";
import { evalKeyframes } from "@/lib/effects";
import type { ProjectDoc } from "@/lib/project-types";
import { DEFAULT_SUBTITLE_STYLE } from "@/lib/project-types";

function doc(): ProjectDoc {
  return {
    formatVersion: 1,
    meta: {
      id: "p1",
      name: "t",
      createdAt: "x",
      modifiedAt: "x",
      creatoraVersion: "0",
    },
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, background: "#000" },
    timeline: { tracks: [], markers: [] },
    versions: [],
    subtitles: [],
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
    brandKitId: null,
    ducking: [],
    exportProfiles: [],
    mediaRefs: [{ assetId: "a1", path: "/m/a.mp4", hash: null }],
  };
}

describe("time model", () => {
  it("frame<->ms round-trips at 30fps", () => {
    const d = doc();
    for (const f of [0, 1, 17, 90, 1024]) {
      expect(msToFrame(frameToMs(f, d), d)).toBe(f);
    }
    // 30fps frame = 33.33ms; 50ms lands on frame 2 (66.6ms)... actually nearest.
    expect(msToFrame(50, d)).toBe(2);
    expect(snapToFrame(50, d)).toBe(67);
  });

  it("timecode renders HH:MM:SS:FF", () => {
    const d = doc();
    expect(timecode(0, d)).toBe("00:00:00:00");
    expect(timecode(61033, d)).toBe("00:01:01:01"); // 61.033s → f=1831 → 61s +1f
  });
});

describe("ops", () => {
  it("addClip snaps to frames and sorts", () => {
    const d = doc();
    const r1 = addClip(d, { mediaRef: "a1", startMs: 1000, durationMs: 2000 });
    const r2 = addClip(r1.doc, { mediaRef: "a1", startMs: 0, durationMs: 500 });
    const t = r2.doc.timeline.tracks[0];
    expect(t.kind).toBe("video");
    expect(t.clips[0].startMs).toBe(0);
    expect(t.clips[1].startMs).toBe(1000);
    // Original doc untouched (immutability).
    expect(d.timeline.tracks).toHaveLength(0);
  });

  it("move/trim/split keep source alignment", () => {
    const d = doc();
    const { doc: d1, clipId } = addClip(d, {
      mediaRef: "a1",
      startMs: 0,
      durationMs: 4000,
      sourceInMs: 1000,
    });

    // Trim start +1s: start=1000, dur=3000, sourceIn=2000.
    const d2 = trimClip(d1, clipId, "start", 1000);
    const c = findClip(d2, clipId)!.clip;
    expect([c.startMs, c.durationMs, c.sourceInMs]).toEqual([1000, 3000, 2000]);

    // Split at 2s → left 1s(src 2000) + right 1s(src 3000) at t=2000.
    const s = splitClip(d2, clipId, 2000)!;
    const left = findClip(s.doc, clipId)!.clip;
    const right = findClip(s.doc, s.rightClipId)!.clip;
    expect([left.startMs, left.durationMs, left.sourceInMs]).toEqual([1000, 1000, 2000]);
    expect([right.startMs, right.durationMs, right.sourceInMs]).toEqual([2000, 2000, 3000]);

    // Move right clip +500ms.
    const d3 = moveClip(s.doc, s.rightClipId, 2500);
    expect(findClip(d3, s.rightClipId)!.clip.startMs).toBe(2500);

    // Timeline duration tracks clip ends.
    expect(timelineDuration(d3)).toBe(4500);
  });

  it("trim clamps to ≥1 frame and ≥0", () => {
    const d = doc();
    const { doc: d1, clipId } = addClip(d, { mediaRef: "a1", startMs: 1000, durationMs: 2000 });
    const over = trimClip(d1, clipId, "end", -99999);
    expect(findClip(over, clipId)!.clip.durationMs).toBe(33); // 1 frame @30fps
    // sourceIn=0 → can't reveal earlier media: start stays put.
    const neg = trimClip(d1, clipId, "start", -99999);
    expect(findClip(neg, clipId)!.clip.startMs).toBe(1000);
    expect(findClip(neg, clipId)!.clip.sourceInMs).toBe(0);
  });

  it("remove + update work immutably", () => {
    const d = doc();
    const { doc: d1, clipId } = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 });
    const d2 = updateClip(d1, clipId, { volume: 0.5, transform: { x: 40 } });
    const c = findClip(d2, clipId)!.clip;
    expect(c.volume).toBe(0.5);
    expect(c.transform.x).toBe(40);
    const d3 = removeClip(d2, clipId);
    expect(d3.timeline.tracks[0].clips).toHaveLength(0);
  });
});

describe("active/preview math", () => {
  it("activeClipsAt maps timeline → source time (mirrors render atrim)", () => {
    const d = doc();
    const { doc: d1, clipId } = addClip(d, {
      mediaRef: "a1",
      startMs: 1000,
      durationMs: 2000,
      sourceInMs: 500,
    });
    expect(activeClipsAt(d1, 500)).toHaveLength(0);
    const at = activeClipsAt(d1, 1500);
    expect(at).toHaveLength(1);
    expect(at[0].clip.id).toBe(clipId);
    expect(at[0].sourceMs).toBe(1000); // 500 + (1500-1000)
    expect(activeClipsAt(d1, 3000)).toHaveLength(0);
  });

  it("clipRect mirrors the overlay formula", () => {
    const d = doc();
    const { doc: d1, clipId } = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 });
    let c = findClip(d1, clipId)!.clip;
    // 320x240 source in 1920x1080 canvas → fit by height: 4.5 → 1440x1080.
    const r = clipRect(d1, c, 320, 240);
    expect(r.w).toBeCloseTo(1440);
    expect(r.h).toBeCloseTo(1080);
    expect(r.x).toBeCloseTo((1920 - 1440) / 2);
    // scaleX .5 + x offset 100 → w 720, x=(1920-720)/2+100=700.
    const d2 = updateClip(d1, clipId, { transform: { scaleX: 0.5, x: 100 } });
    c = findClip(d2, clipId)!.clip;
    const r2 = clipRect(d2, c, 320, 240);
    expect(r2.w).toBeCloseTo(720);
    expect(r2.x).toBeCloseTo(700);
  });
});

describe("effects / keyframes / transitions", () => {
  const fx = (type: string, params: Record<string, number> = {}) => ({
    id: `fx-${type}`,
    type,
    enabled: true,
    params,
  });

  it("add/update/remove effect respects lock", () => {
    const { doc: d1, clipId } = addClip(doc(), { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    const d2 = addEffect(d1, clipId, fx("brightness", { amount: 0.5 }));
    expect(findClip(d2, clipId)!.clip.effects).toHaveLength(1);
    const d3 = updateEffect(d2, clipId, "fx-brightness", { params: { amount: -0.25 } });
    expect(findClip(d3, clipId)!.clip.effects[0].params.amount).toBe(-0.25);
    const d4 = removeEffect(d3, clipId, "fx-brightness");
    expect(findClip(d4, clipId)!.clip.effects).toHaveLength(0);
    const lock = setTrackFlag(d4, d4.timeline.tracks[0].id, { locked: true });
    expect(findClip(addEffect(lock, clipId, fx("blur")), clipId)!.clip.effects).toHaveLength(0);
  });

  it("setKeyframe inserts sorted and clamps to clip bounds", () => {
    const { doc: d1, clipId } = addClip(doc(), { mediaRef: "a1", startMs: 0, durationMs: 1000 });
    let d = setKeyframe(d1, clipId, "volume", 800, 0.2);
    d = setKeyframe(d, clipId, "volume", 100, 0.9);
    d = setKeyframe(d, clipId, "volume", 5000, 1);
    const kfs = findClip(d, clipId)!.clip.keyframes["volume"];
    expect(kfs.map((k) => k.tMs)).toEqual([100, 800, 1000]);
    d = setKeyframe(d, clipId, "volume", 100, 0.5);
    expect(findClip(d, clipId)!.clip.keyframes["volume"].find((k) => k.tMs === 100)!.v).toBe(0.5);
    d = removeKeyframe(d, clipId, "volume", 100);
    expect(findClip(d, clipId)!.clip.keyframes["volume"]).toHaveLength(2);
  });

  it("evalKeyframes linear interp + clamp mirrors Rust", () => {
    const kfs = [{ tMs: 100, v: 0, ease: "linear" }, { tMs: 900, v: 1, ease: "linear" }];
    expect(evalKeyframes(kfs, 0, 0.7)).toBe(0);
    expect(evalKeyframes(kfs, 500, 0.7)).toBeCloseTo(0.5);
    expect(evalKeyframes(kfs, 2000, 0.7)).toBe(1);
    expect(evalKeyframes([], 50, 0.7)).toBe(0.7);
    expect(evalKeyframes(undefined, 50, 0.7)).toBe(0.7);
  });

  it("addTransition overlaps B into A tail; transitionAlpha ramps", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    d = a.doc;
    const b = addClip(d, { mediaRef: "a1", startMs: 2000, durationMs: 2000 });
    d = b.doc;
    const res = addTransition(d, d.timeline.tracks[0].id, a.clipId, b.clipId, 500);
    expect(res).not.toBeNull();
    d = res!.doc;
    const nb = findClip(d, b.clipId)!.clip;
    expect(nb.startMs).toBe(1500);
    expect(transitionAlpha(d, a.clipId, 1500)).toBeCloseTo(1);
    expect(transitionAlpha(d, a.clipId, 1750)).toBeCloseTo(0.5);
    expect(transitionAlpha(d, b.clipId, 1750)).toBeCloseTo(0.5);
    expect(transitionAlpha(d, a.clipId, 1000)).toBe(1);
    const tr = res!.transitionId;
    d = removeTransition(d, d.timeline.tracks[0].id, tr);
    expect(d.timeline.tracks[0].transitions).toHaveLength(0);
  });

  it("re-applying a transition on the same junction replaces it (no stacking)", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    d = a.doc;
    const b = addClip(d, { mediaRef: "a1", startMs: 2000, durationMs: 2000 });
    d = b.doc;
    const tid = d.timeline.tracks[0].id;
    d = addTransition(d, tid, a.clipId, b.clipId, 500, "velocitySwipe")!.doc;
    d = addTransition(d, tid, a.clipId, b.clipId, 900, "liquidMelt")!.doc;
    const trs = d.timeline.tracks[0].transitions;
    expect(trs).toHaveLength(1);
    expect(trs[0].type).toBe("liquidMelt");
    expect(trs[0].durationMs).toBe(900);
    expect(findClip(d, b.clipId)!.clip.startMs).toBe(1100);
  });

  it("transitions ripple later clips so junctions can be chained and resized", () => {
    let d = doc();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = addClip(d, { mediaRef: "a1", startMs: i * 2000, durationMs: 2000 });
      d = r.doc;
      ids.push(r.clipId);
    }
    const tid = d.timeline.tracks[0].id;
    d = addTransition(d, tid, ids[0], ids[1], 500, "velocitySwipe")!.doc;
    // C followed B: still adjacent after the ripple → second transition works
    expect(findClip(d, ids[2])!.clip.startMs).toBe(3500);
    d = addTransition(d, tid, ids[1], ids[2], 900, "liquidMelt")!.doc;
    const start = (i: number) => findClip(d, ids[i])!.clip.startMs;
    expect([start(0), start(1), start(2)]).toEqual([0, 1500, 2600]);
    // resizing the first one moves B and C together; B→C overlap is preserved
    const first = d.timeline.tracks[0].transitions.find((t) => t.clipB === ids[1])!;
    d = setTransitionDuration(d, tid, first.id, 800);
    expect([start(0), start(1), start(2)]).toEqual([0, 1200, 2300]);
    expect(start(1) + 2000 - start(2)).toBe(900);
  });

  it("dipToBlack alpha dips each side to zero at midpoint edges", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    d = a.doc;
    const b = addClip(d, { mediaRef: "a1", startMs: 2000, durationMs: 2000 });
    d = b.doc;
    const res = addTransition(d, d.timeline.tracks[0].id, a.clipId, b.clipId, 400, "dipToBlack");
    d = res!.doc;
    expect(transitionAlpha(d, a.clipId, 1800)).toBeCloseTo(0);
    expect(transitionAlpha(d, b.clipId, 1800)).toBeCloseTo(0);
    expect(transitionAlpha(d, a.clipId, 1700)).toBeCloseTo(0.5);
    expect(transitionAlpha(d, b.clipId, 1900)).toBeCloseTo(0.5);
  });
});

describe("tracks", () => {
  it("addTrack auto-names and removeTrack drops clips", () => {
    let d = doc();
    const v1 = addTrack(d, "video");
    d = v1.doc;
    const v2 = addTrack(d, "video");
    d = v2.doc;
    const a1 = addTrack(d, "audio");
    d = a1.doc;
    expect(d.timeline.tracks.map((t) => t.name)).toEqual(["V1", "V2", "A1"]);
    const { doc: d2, clipId } = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 });
    expect(d2.timeline.tracks[0].clips).toHaveLength(1);
    const d3 = removeTrack(d2, d2.timeline.tracks[0].id);
    expect(d3.timeline.tracks).toHaveLength(2);
    expect(findClip(d3, clipId)).toBeNull();
  });

  it("rename + flags + reorder", () => {
    let d = doc();
    const v1 = addTrack(d, "video");
    const v2 = addTrack(v1.doc, "video");
    d = renameTrack(v2.doc, v1.trackId, "Main");
    expect(d.timeline.tracks[0].name).toBe("Main");
    d = setTrackFlag(d, v1.trackId, { locked: true });
    expect(d.timeline.tracks[0].locked).toBe(true);
    d = setTrackFlag(d, v1.trackId, { muted: true });
    expect(d.timeline.tracks[0].muted).toBe(true);
    d = moveTrackOrder(d, v2.trackId, -1);
    expect(d.timeline.tracks[0].id).toBe(v2.trackId);
  });

  it("locked track blocks clip mutations", () => {
    let d = doc();
    const { doc: d1, clipId } = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 });
    const trackId = d1.timeline.tracks[0].id;
    d = setTrackFlag(d1, trackId, { locked: true });
    expect(findClip(moveClip(d, clipId, 500), clipId)!.clip.startMs).toBe(0);
    expect(findClip(trimClip(d, clipId, "end", 200), clipId)!.clip.durationMs).toBe(1000);
    expect(findClip(updateClip(d, clipId, { volume: 0.1 }), clipId)!.clip.volume).toBe(1);
    expect(findClip(d, clipId)).not.toBeNull();
    expect(findClip(removeClip(d, clipId), clipId)).not.toBeNull();
  });
});

describe("batch clip ops", () => {
  it("moveClips shifts by delta, snapping each", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 500 });
    const b = addClip(a.doc, { mediaRef: "a1", startMs: 1000, durationMs: 500 });
    d = moveClips(b.doc, [a.clipId, b.clipId], 100);
    expect(findClip(d, a.clipId)!.clip.startMs).toBe(100);
    expect(findClip(d, b.clipId)!.clip.startMs).toBe(1100);
  });

  it("extract/paste preserves layout relative to earliest start", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 1000, durationMs: 500 });
    const b = addClip(a.doc, { mediaRef: "a1", startMs: 2000, durationMs: 500 });
    const clipIds = [a.clipId, b.clipId];
    const clips = extractClips(b.doc, clipIds);
    expect(clips).toHaveLength(2);
    const { doc: d2, clipIds: ids } = pasteClips(b.doc, clips, 5000);
    const c0 = findClip(d2, ids[0])!.clip;
    const c1 = findClip(d2, ids[1])!.clip;
    expect(c0.startMs).toBe(5000);
    expect(c1.startMs).toBe(6000);
    expect(ids[0]).not.toBe(a.clipId);
  });

  it("duplicateClips lands after latest end", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 });
    const { doc: d2, clipIds: dupIds } = duplicateClips(a.doc, [a.clipId]);
    const c = findClip(d2, dupIds[0])!.clip;
    expect(c.startMs).toBe(1000);
    expect(c.id).not.toBe(a.clipId);
  });

  it("removeClips skips locked tracks", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 500 });
    const trackId = a.doc.timeline.tracks[0].id;
    d = setTrackFlag(a.doc, trackId, { locked: true });
    const { doc: d2, removed } = removeClips(d, [a.clipId]);
    expect(removed).toBe(0);
    expect(findClip(d2, a.clipId)).not.toBeNull();
  });
});

describe("3E hardening fixes", () => {
  it("splitClip remaps right-half keyframes to its origin", () => {
    const { doc: d1, clipId } = addClip(doc(), { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    let d = setKeyframe(d1, clipId, "volume", 0, 0.2);
    d = setKeyframe(d, clipId, "volume", 1000, 0.8);
    d = setKeyframe(d, clipId, "volume", 1500, 1.0);
    const r = splitClip(d, clipId, 1000)!;
    const left = findClip(r.doc, clipId)!.clip;
    const right = findClip(r.doc, r.rightClipId)!.clip;
    expect(left.keyframes["volume"].map((k) => k.tMs)).toEqual([0, 1000]);
    // 1500 - 1000 = 500 on the right half's origin; cut-point key stays for continuity
    expect(right.keyframes["volume"].map((k) => [k.tMs, k.v])).toEqual([[0, 0.8], [500, 1.0]]);
  });

  it("splitClip re-points outgoing transition to the right half", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    const b = addClip(a.doc, { mediaRef: "a1", startMs: 2000, durationMs: 1000 });
    d = b.doc;
    d = addTransition(d, d.timeline.tracks[0].id, a.clipId, b.clipId, 400)!.doc;
    const r = splitClip(d, a.clipId, 1000)!;
    const tr = r.doc.timeline.tracks[0].transitions[0];
    expect(tr.clipA).toBe(r.rightClipId);
  });

  it("removeClip + removeClips drop dangling transitions", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    const b = addClip(a.doc, { mediaRef: "a1", startMs: 2000, durationMs: 1000 });
    d = addTransition(b.doc, b.doc.timeline.tracks[0].id, a.clipId, b.clipId, 400)!.doc;
    expect(d.timeline.tracks[0].transitions).toHaveLength(1);
    d = removeClip(d, b.clipId);
    expect(d.timeline.tracks[0].transitions).toHaveLength(0);
    // batch path
    const a2 = addClip(d, { mediaRef: "a1", startMs: 2000, durationMs: 1000 });
    d = addTransition(a2.doc, a2.doc.timeline.tracks[0].id, a.clipId, a2.clipId, 400)!.doc;
    const { doc: d2 } = removeClips(d, [a2.clipId]);
    expect(d2.timeline.tracks[0].transitions).toHaveLength(0);
  });

  it("trimClip start never makes sourceIn negative", () => {
    const { doc: d1, clipId } = addClip(doc(), {
      mediaRef: "a1", startMs: 1000, durationMs: 1000, sourceInMs: 300,
    });
    const d2 = trimClip(d1, clipId, "start", -2000);
    const c = findClip(d2, clipId)!.clip;
    expect(c.sourceInMs).toBe(0); // clamped, not -1700
    expect(c.startMs).toBe(700); // only revealed 300ms
  });

  it("trimClip end clamps to sourceDurationMs", () => {
    const { doc: d1, clipId } = addClip(doc(), {
      mediaRef: "a1", startMs: 0, durationMs: 1000, sourceInMs: 500,
      sourceDurationMs: 2000,
    });
    const d2 = trimClip(d1, clipId, "end", 5000);
    const c = findClip(d2, clipId)!.clip;
    expect(c.durationMs).toBe(1500); // 2000 - 500 source left
  });

  it("moveClipToTrack moves to compatible track and drops transitions", () => {
    let d = doc();
    const a = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 }); // V1
    const b = addClip(a.doc, { mediaRef: "a1", startMs: 1000, durationMs: 1000 });
    const v2 = addTrack(b.doc, "video"); // V2
    const a1 = addTrack(v2.doc, "audio"); // A1
    d = a1.doc;
    d = addTransition(d, d.timeline.tracks[0].id, a.clipId, b.clipId, 300)!.doc;
    // video clip onto audio track → rejected
    const dBad = moveClipToTrack(d, a.clipId, a1.trackId, 0);
    expect(findClip(dBad, a.clipId)!.track.kind).toBe("video");
    // onto V2 at 500ms → moved, transitions dropped from source track
    const d2 = moveClipToTrack(d, a.clipId, v2.trackId, 500);
    const hit = findClip(d2, a.clipId)!;
    expect(hit.track.id).toBe(v2.trackId);
    expect(hit.clip.startMs).toBe(500);
    expect(d2.timeline.tracks[0].transitions).toHaveLength(0);
  });

  it("pasteClips on empty clipboard is a no-op", () => {
    const d = doc();
    const { doc: d2, clipIds } = pasteClips(d, [], 1000);
    expect(clipIds).toEqual([]);
    expect(d2.timeline.tracks).toHaveLength(0);
  });
});

describe("format versions (ADR-021)", () => {
  const withClip = () => {
    let d = doc();
    const r = addClip(d, {
      mediaRef: "a1",
      trackKind: "video",
      startMs: 0,
      durationMs: 2000,
    });
    return { d: r.doc, clipId: r.clipId };
  };

  it("applyVersion overrides only whitelisted fields; base untouched", () => {
    const { d, clipId } = withClip();
    const { doc: v1, versionId } = addVersion(d, {
      name: "9:16",
      canvas: { width: 1080, height: 1920, fpsNum: 30, fpsDen: 1, background: "#000" },
    });
    const v2 = setVersionClipOverride(v1, versionId, clipId, {
      transform: { x: -100, y: 0, scaleX: 2, scaleY: 2, rotationDeg: 0, opacity: 1, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
      keyframes: { "transform.x": [{ tMs: 0, v: -50, ease: "linear" }] },
    });
    const merged = applyVersion(v2, versionId)!;
    expect(merged.canvas.width).toBe(1080);
    const clip = merged.timeline.tracks[0].clips[0];
    expect(clip.transform.x).toBe(-100);
    expect(clip.keyframes["transform.x"][0].v).toBe(-50);
    // shared structure identical
    expect(clip.durationMs).toBe(2000);
    // base doc untouched
    const base = v2.timeline.tracks[0].clips[0];
    expect(base.transform.x).toBe(0);
    expect(base.keyframes["transform.x"]).toBeUndefined();
  });

  it("edits to one version never leak to another", () => {
    const { d, clipId } = withClip();
    const { doc: d1, versionId: vA } = addVersion(d, { name: "A", canvas: { width: 100, height: 100, fpsNum: 30, fpsDen: 1, background: "#000" } });
    const { doc: d2, versionId: vB } = addVersion(d1, { name: "B", canvas: { width: 200, height: 200, fpsNum: 30, fpsDen: 1, background: "#000" } });
    const d3 = setVersionClipOverride(d2, vA, clipId, {
      transform: { x: 9, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
    });
    const mB = applyVersion(d3, vB)!;
    expect(mB.timeline.tracks[0].clips[0].transform.x).toBe(0); // B unaffected
  });

  it("duplicate + reset behave", () => {
    const { d, clipId } = withClip();
    const { doc: d1, versionId } = addVersion(d, { name: "A", canvas: { width: 100, height: 100, fpsNum: 30, fpsDen: 1, background: "#000" } });
    const d2 = setVersionClipOverride(d1, versionId, clipId, { transform: { x: 5, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 } });
    const { doc: d3, versionId: dup } = duplicateVersion(d2, versionId);
    expect(d3.versions).toHaveLength(2);
    expect(d3.versions.find((v) => v.id === dup)!.clipOverrides[clipId].transform!.x).toBe(5);
    const d4 = resetVersion(d3, versionId);
    expect(d4.versions.find((v) => v.id === versionId)!.clipOverrides).toEqual({});
    expect(removeVersion(d4, dup!).versions).toHaveLength(1);
  });
});

describe("per-version text overrides (Phase 4.1)", () => {
  it("applyVersion replaces text + style only in the version", () => {
    let d = doc();
    const t = addTextClip(d, { text: "YT Title", startMs: 0, durationMs: 1000 });
    d = t.doc;
    const { doc: d1, versionId } = addVersion(d, {
      name: "TK",
      canvas: { width: 240, height: 426, fpsNum: 30, fpsDen: 1, background: "#000" },
    });
    const d2 = setVersionClipOverride(d1, versionId, t.clipId, {
      text: "TK Title",
      textStyle: { ...d1.timeline.tracks[0].clips[0].textStyle!, color: "#FF0000" },
    });
    const m = applyVersion(d2, versionId)!;
    const c = m.timeline.tracks[0].clips[0];
    expect(c.text).toBe("TK Title");
    expect(c.textStyle!.color).toBe("#FF0000");
    expect(d2.timeline.tracks[0].clips[0].text).toBe("YT Title");
  });
});

describe("subtitle cues (ADR-025)", () => {
  const withCues = () => {
    const d = doc();
    d.subtitles = [
      { id: "a", startMs: 1000, endMs: 3000, text: "Hello world", styleId: null,
        words: [{ word: "Hello", startMs: 1000, endMs: 1800 }, { word: " world", startMs: 1800, endMs: 2800 }] },
      { id: "b", startMs: 2800, endMs: 5000, text: "Second cue", styleId: null, words: [] },
    ];
    return d;
  };

  it("splitCue splits at word boundary preserving timing", () => {
    const r = splitCue(withCues(), "a", 1800)!;
    const [l, rr] = r.doc.subtitles;
    expect(l.text).toBe("Hello");
    expect(rr.startMs).toBe(1800);
    expect(rr.words[0].word).toBe(" world");
  });

  it("mergeCueWithNext joins text + span + words", () => {
    const r = mergeCueWithNext(withCues(), "a")!;
    const m = r.doc.subtitles[0];
    expect(m.text).toBe("Hello world Second cue");
    expect(m.startMs).toBe(1000);
    expect(m.endMs).toBe(5000);
    expect(m.words).toHaveLength(2);
  });

  it("shiftAllCues shifts words too and clamps at 0", () => {
    const d = shiftAllCues(withCues(), -2000);
    expect(d.subtitles[0].startMs).toBe(0);
    expect(d.subtitles[0].words[0].startMs).toBe(0);
  });

  it("fixOverlaps clamps earlier end to next start", () => {
    const d = fixOverlaps(withCues()); // a ends 3000 > b starts 2800
    expect(d.subtitles[0].endMs).toBe(2800);
  });

  it("diagnoseCues flags overlap + short cue without mutating", () => {
    const d = withCues();
    const issues = diagnoseCues(d);
    expect(issues.some((i) => i.kind === "overlap")).toBe(true);
    expect(d.subtitles[0].endMs).toBe(3000); // unchanged
  });

  it("findReplaceCues replaces all occurrences", () => {
    const r = findReplaceCues(withCues(), "world", "earth");
    expect(r.count).toBe(1);
    expect(r.doc.subtitles[0].text).toBe("Hello earth");
  });

  it("applyVersion merges per-version subtitleStyle", () => {
    const d = withCues();
    const v = addVersion(d, { name: "v", canvas: { width: 9, height: 16, fpsNum: 30, fpsDen: 1, background: "#000" } }).doc;
    const styled = setVersionSubtitleStyle(v, v.versions[0].id, { ...v.subtitleStyle, mode: "karaoke", marginVPx: 200 });
    const merged = applyVersion(styled, styled.versions[0].id)!;
    expect(merged.subtitleStyle.mode).toBe("karaoke");
    expect(styled.subtitleStyle.mode).toBe("none"); // master untouched
  });
});

describe("audio studio ops (ADR-026)", () => {
  const audioDoc = () => {
    let d = doc();
    const t1 = addTrack(d, "audio");
    d = t1.doc;
    const t2 = addTrack(d, "audio");
    d = t2.doc;
    return { d, voice: t1.trackId, music: t2.trackId };
  };

  it("setTrackFlag writes volume/solo (undo-safe)", () => {
    const { d, music } = audioDoc();
    const d2 = setTrackFlag(d, music, { volume: 0.5, solo: true });
    const tr = d2.timeline.tracks.find((t) => t.id === music)!;
    expect(tr.volume).toBe(0.5);
    expect(tr.solo).toBe(true);
    expect(d.timeline.tracks[1].volume).toBe(1); // immutability
  });

  it("ducking rules upsert/remove", () => {
    const { d, voice, music } = audioDoc();
    const rule = { id: "r1", sourceTrack: voice, targetTrack: music, thresholdDb: -35, reductionDb: -12, attackMs: 80, releaseMs: 500, holdMs: 300 };
    const d2 = upsertDuckingRule(d, rule);
    expect(d2.ducking).toHaveLength(1);
    const d3 = upsertDuckingRule(d2, { ...rule, reductionDb: -20 });
    expect(d3.ducking).toHaveLength(1);
    expect(d3.ducking[0].reductionDb).toBe(-20);
    expect(removeDuckingRule(d3, "r1").ducking).toHaveLength(0);
  });

  it("applySilenceCut splits a clip into keep-regions with padding", () => {
    const { d, voice } = audioDoc();
    const r = addClip(d, { trackId: voice, mediaRef: "a1", startMs: 0, durationMs: 10000, sourceInMs: 1000 });
    const dd = r.doc;
    const cut = applySilenceCut(dd, r.clipId, [
      { startMs: 3000, endMs: 5000 },
      { startMs: 8000, endMs: 100000 },
    ], 100);
    expect(cut).not.toBeNull();
    const clips = cut!.timeline.tracks.find((t) => t.id === voice)!.clips;
    // keep [1000,3100) and [4900,8100): silence 3–5s and 8s+ removed, 100ms pad each side
    expect(clips).toHaveLength(2);
    expect(clips[0].sourceInMs).toBe(1000);
    expect(clips[0].durationMs).toBe(2100);
    expect(clips[1].sourceInMs).toBe(4900);
    expect(clips[1].durationMs).toBe(3200);
    expect(clips[1].startMs).toBe(2100); // butt-joined
  });

  it("applySilenceCut returns null when nothing is removable", () => {
    const { d, voice } = audioDoc();
    const r = addClip(d, { trackId: voice, mediaRef: "a1", startMs: 0, durationMs: 10000 });
    expect(applySilenceCut(r.doc, r.clipId, [], 100)).toBeNull();
    expect(applySilenceCut(r.doc, "nope", [{ startMs: 0, endMs: 5 }], 100)).toBeNull();
  });
});

describe("graphics studio (ADR-027)", () => {
  const mkTitle = (d: ProjectDoc) =>
    addGeneratedClip(d, "text", { startMs: 1000, durationMs: 3000, text: "Hi" });

  it("addGeneratedClip places on matching track with defaults", () => {
    const d = doc();
    const { doc: d1, clipId } = mkTitle(d);
    const t = d1.timeline.tracks.find((t) => t.kind === "text")!;
    expect(t.clips[0].id).toBe(clipId);
    expect(t.clips[0].text).toBe("Hi");
    expect(t.clips[0].hidden).toBe(false);
    // shape clip on graphics track
    const { doc: d2, clipId: sid } = addGeneratedClip(d1, "graphics", {
      startMs: 0,
      durationMs: 1000,
      shape: { kind: "rect", fill: "#FF0000", outlineColor: null, outlineWidth: 0, widthPx: 100, heightPx: 50 },
    });
    const g = d2.timeline.tracks.find((t) => t.kind === "graphics")!;
    expect(g.clips[0].id).toBe(sid);
    expect(g.clips[0].shape?.fill).toBe("#FF0000");
  });

  it("applyAnimationPreset bakes keyframes on base when no version", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const d2 = applyAnimationPreset(d1, clipId, "fadeIn", { durationMs: 500 });
    const c = findClip(d2, clipId)!.clip;
    const kfs = c.keyframes["transform.opacity"];
    expect(kfs.length).toBeGreaterThan(3);
    expect(kfs[0].v).toBe(0);
    expect(kfs[kfs.length - 1].v).toBe(1);
  });

  it("applyAnimationPreset writes into version overrides — other versions untouched", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const { doc: d2, versionId } = addVersion(d1, {
      name: "9x16",
      canvas: { width: 1080, height: 1920, fpsNum: 30, fpsDen: 1, background: "#000" },
    });
    const d3 = applyAnimationPreset(d2, clipId, "slideIn", {
      durationMs: 400,
      versionId,
    });
    const v = d3.versions.find((x) => x.id === versionId)!;
    const ov = v.clipOverrides[clipId];
    expect(ov.keyframes?.["transform.x"]?.length).toBeGreaterThan(3);
    // base clip untouched
    expect(findClip(d3, clipId)!.clip.keyframes["transform.x"]).toBeUndefined();
    // merged version applies them
    const merged = applyVersion(d3, versionId)!;
    expect(findClip(merged, clipId)!.clip.keyframes["transform.x"]!.length).toBeGreaterThan(3);
  });

  it("textFx preset is versioned via clipOverrides.textFx", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const { doc: d2, versionId } = addVersion(d1, {
      name: "sq",
      canvas: { width: 1080, height: 1080, fpsNum: 30, fpsDen: 1, background: "#000" },
    });
    const d3 = applyAnimationPreset(d2, clipId, "typewriter", { durationMs: 1000, versionId });
    const ov = d3.versions[0].clipOverrides[clipId];
    expect(ov.textFx?.kind).toBe("typewriter");
    // base has no textFx
    expect(findClip(d3, clipId)!.clip.textFx).toBeNull();
    const merged = applyVersion(d3, versionId)!;
    expect(findClip(merged, clipId)!.clip.textFx?.kind).toBe("typewriter");
  });

  it("textFx preset is a no-op on non-text/graphics clips", () => {
    const { doc: d1, clipId } = addClip(doc(), { mediaRef: "a1", startMs: 0, durationMs: 2000 });
    const d2 = applyAnimationPreset(d1, clipId, "typewriter", { durationMs: 1000 });
    expect(findClip(d2, clipId)!.clip.textFx ?? null).toBeNull();
    // keyframe presets still work on media clips
    const d3 = applyAnimationPreset(d1, clipId, "fadeIn", { durationMs: 300 });
    expect(findClip(d3, clipId)!.clip.keyframes["transform.opacity"].length).toBeGreaterThan(0);
  });

  it("baked keyframes carry the preset tag and retime per group", () => {
    const { doc: d1, clipId } = addClip(doc(), { mediaRef: "a1", startMs: 0, durationMs: 4000 });
    const d2 = applyAnimationPreset(d1, clipId, "fadeIn", { durationMs: 500 });
    const c = findClip(d2, clipId)!.clip;
    const kfs = c.keyframes["transform.opacity"];
    expect(kfs.every((k) => k.anim === "fadeIn")).toBe(true);

    // Retime only the fadeIn group: 0–500 → 0–1000 doubles the span.
    const d3 = retimeClipKeyframes(d2, clipId, null, "fadeIn", (t) => t * 2);
    const rk = findClip(d3, clipId)!.clip.keyframes["transform.opacity"];
    expect(rk[rk.length - 1].tMs).toBe(1000);
    // Untagged groups untouched.
    const d4 = retimeClipKeyframes(d3, clipId, null, "slideIn", (t) => t + 1);
    expect(findClip(d4, clipId)!.clip.keyframes["transform.opacity"].at(-1)!.tMs).toBe(1000);
  });

  it("clipStylePayload + applyClipStyle copy style across clips", () => {
    const { doc: d1, clipId: a } = mkTitle(doc());
    const d2 = updateClip(d1, a, {
      textStyle: { ...d1.timeline.tracks[0].clips[0].textStyle!, color: "#FF0000", shadowColor: "#000000CC", shadowX: 4, shadowY: 4 },
    });
    const { doc: d3, clipId: b } = addGeneratedClip(d2, "text", { startMs: 0, durationMs: 1000, text: "B" });
    const payload = clipStylePayload(findClip(d3, a)!.clip);
    const d4 = applyClipStyle(d3, b, payload);
    const bc = findClip(d4, b)!.clip;
    expect(bc.textStyle?.color).toBe("#FF0000");
    expect(bc.textStyle?.shadowColor).toBe("#000000CC");
    expect(bc.text).toBe("B"); // text content NOT replaced by style paste
  });

  it("alignClipTo positions around canvas edges/center", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const d2 = alignClipTo(d1, clipId, "right", 100);
    expect(findClip(d2, clipId)!.clip.transform.x).toBe(1920 / 2 - 100);
    const d3 = alignClipTo(d2, clipId, "middle");
    expect(findClip(d3, clipId)!.clip.transform.y).toBe(0);
  });

  it("brand bind applies color/font from snapshot; unbind clears bindings", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const kit = {
      id: "k1",
      name: "Acme",
      colors: ["#123456"],
      fonts: [{ name: "A", path: "C:/Windows/Fonts/arial.ttf" }],
      logos: [],
      titleStyle: d1.subtitleStyle.text,
    };
    const d2 = setDocBrandKit(d1, kit);
    const d3 = bindClipBrand(d2, clipId, { colorSlot: 0, fontSlot: 0 });
    const c = findClip(d3, clipId)!.clip;
    expect(c.brandBindings?.colorSlot).toBe(0);
    expect(c.textStyle?.color).toBe("#123456");
    expect(c.textStyle?.fontFile).toBe("C:/Windows/Fonts/arial.ttf");
    // unbind keeps the applied values, drops the slots
    const d4 = bindClipBrand(d3, clipId, { colorSlot: null, fontSlot: null });
    const c4 = findClip(d4, clipId)!.clip;
    expect(c4.brandBindings).toBeNull();
    expect(c4.textStyle?.color).toBe("#123456");
  });

  it("applyBrandToBoundClips re-applies only bound slots, leaves custom values", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const kit = {
      id: "k1",
      name: "Acme",
      colors: ["#AAAAAA", "#BBBBBB"],
      fonts: [],
      logos: [],
      titleStyle: d1.subtitleStyle.text,
    };
    let d = setDocBrandKit(d1, kit);
    d = bindClipBrand(d, clipId, { colorSlot: 0 });
    // user recolors manually — bound slots get re-applied on explicit apply
    d = updateClip(d, clipId, {
      textStyle: { ...findClip(d, clipId)!.clip.textStyle!, fontSizePx: 99 },
    });
    const kit2 = { ...kit, colors: ["#CCCCCC", "#BBBBBB"] };
    d = setDocBrandKit(d, kit2);
    d = applyBrandToBoundClips(d);
    const c = findClip(d, clipId)!.clip;
    expect(c.textStyle?.color).toBe("#CCCCCC"); // re-applied from slot
    expect(c.textStyle?.fontSizePx).toBe(99); // custom field untouched
  });

  it("per-version hidden merges; clearVersionClipOverrides re-syncs", () => {
    const { doc: d1, clipId } = mkTitle(doc());
    const { doc: d2, versionId } = addVersion(d1, {
      name: "sq",
      canvas: { width: 1080, height: 1080, fpsNum: 30, fpsDen: 1, background: "#000" },
    });
    const d3 = setVersionClipOverride(d2, versionId, clipId, { hidden: true });
    const merged = applyVersion(d3, versionId)!;
    expect(findClip(merged, clipId)!.clip.hidden).toBe(true);
    // base still visible
    expect(findClip(d3, clipId)!.clip.hidden).toBe(false);
    const d4 = clearVersionClipOverrides(d3, versionId, clipId);
    expect(d4.versions[0].clipOverrides[clipId]).toBeUndefined();
    const merged2 = applyVersion(d4, versionId)!;
    expect(findClip(merged2, clipId)!.clip.hidden).toBe(false);
  });

  it("new clip fields survive JSON serialize/deserialize", () => {
    const { doc: d1, clipId } = addGeneratedClip(doc(), "graphics", {
      startMs: 0,
      durationMs: 2000,
      text: "Branded",
      shape: { kind: "rect", fill: "#FF0000", outlineColor: "#000000", outlineWidth: 2, widthPx: 100, heightPx: 50 },
    });
    let d = updateClip(d1, clipId, {
      textFx: { kind: "wipe", rate: 0, direction: "ltr", durationMs: 500, out: true },
      brandBindings: { colorSlot: 1, fontSlot: null },
      hidden: true,
    });
    const rt: ProjectDoc = JSON.parse(JSON.stringify(d));
    const c = findClip(rt, clipId)!.clip;
    expect(c.shape?.kind).toBe("rect");
    expect(c.shape?.outlineWidth).toBe(2);
    expect(c.textFx?.out).toBe(true);
    expect(c.brandBindings?.colorSlot).toBe(1);
    expect(c.hidden).toBe(true);
  });
});

