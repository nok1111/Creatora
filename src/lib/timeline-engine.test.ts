import { describe, expect, it } from "vitest";
import {
  activeClipsAt,
  addClip,
  clipRect,
  findClip,
  frameToMs,
  moveClip,
  msToFrame,
  removeClip,
  snapToFrame,
  splitClip,
  timecode,
  timelineDuration,
  trimClip,
  updateClip,
} from "@/lib/timeline-engine";
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
