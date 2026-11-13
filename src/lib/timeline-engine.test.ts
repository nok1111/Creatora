import { describe, expect, it } from "vitest";
import {
  activeClipsAt,
  addClip,
  addEffect,
  addTrack,
  addTransition,
  clipRect,
  duplicateClips,
  extractClips,
  findClip,
  frameToMs,
  moveClip,
  moveClips,
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
} from "@/lib/timeline-engine";
import { evalKeyframes } from "@/lib/effects";
import type { ProjectDoc } from "@/lib/project-types";

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
    formats: {},
    subtitles: [],
    brandKitId: null,
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
    const neg = trimClip(d1, clipId, "start", -99999);
    expect(findClip(neg, clipId)!.clip.startMs).toBe(0);
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
