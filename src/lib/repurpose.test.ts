import { describe, expect, it } from "vitest";
import {
  buildClipDoc,
  captionFromText,
  isNonSpeechCue,
  clampRange,
  DEFAULT_TARGET_IDS,
  platformOfPreset,
  reframeKeyframes,
  sliceCues,
} from "@/lib/repurpose";
import { presetById } from "@/lib/format-presets";
import { SUBTITLE_PRESETS } from "@/lib/subtitle-presets";
import type { ProjectDoc, SubtitleCue } from "@/lib/project-types";
import { DEFAULT_SUBTITLE_STYLE } from "@/lib/project-types";

function base(): ProjectDoc {
  return {
    formatVersion: 1,
    meta: { id: "p1", name: "clip", createdAt: "x", modifiedAt: "x", creatoraVersion: "0" },
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, background: "#000" },
    timeline: { tracks: [], markers: [] },
    versions: [],
    subtitles: [],
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
    brandKitId: null,
    ducking: [],
    exportProfiles: [],
    mediaRefs: [],
  };
}

const cue = (id: string, s: number, e: number, text: string, words: SubtitleCue["words"] = []): SubtitleCue => ({
  id,
  startMs: s,
  endMs: e,
  text,
  words,
});

const ASSET = { id: "a1", filePath: "/m/long.mp4", width: 1920, height: 1080, durationMs: 600_000 };

describe("sliceCues", () => {
  const cues = [
    cue("a", 0, 4000, "before the clip."),
    cue("b", 9000, 14000, "inside the clip."),
    cue("c", 19000, 26000, "straddles the end."),
    cue("d", 40000, 44000, "after."),
  ];

  it("keeps overlapping cues and re-times them to the clip start", () => {
    const out = sliceCues(cues, 8000, 22000);
    expect(out.map((c) => c.text)).toEqual(["inside the clip.", "straddles the end."]);
    expect(out[0]).toMatchObject({ startMs: 1000, endMs: 6000 });
    expect(out[1]).toMatchObject({ startMs: 11000, endMs: 14000 }); // clipped to 14 s window
    expect(out.map((c) => c.id)).toEqual(["cue-1", "cue-2"]);
  });

  it("follows word timings and rebuilds text from the words inside the window", () => {
    const w = [
      { word: " one", startMs: 9000, endMs: 9500 },
      { word: " two", startMs: 9500, endMs: 10000 },
      { word: " three", startMs: 10000, endMs: 10500 },
    ];
    const out = sliceCues([cue("x", 9000, 10500, "one two three", w)], 9600, 20000);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("two three");
    expect(out[0]!.words.map((x) => x.startMs)).toEqual([0, 400]);
  });

  it("skips non-speech markup cues so [Music] never becomes a caption", () => {
    const out = sliceCues(
      [cue("a", 0, 10_000, "[Music]"), cue("b", 10_000, 20_000, "real words here.")],
      0,
      20_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("real words here.");
  });

  it("drops cues that only touch the boundary", () => {
    expect(sliceCues([cue("t", 0, 5000, "edge.")], 5000, 10000)).toEqual([]);
  });
});

describe("isNonSpeechCue", () => {
  it("flags whole-cue non-verbal markup", () => {
    for (const t of ["[Music]", "(laughter)", "[BLANK_AUDIO]", "*sighs*", "[Music] (applause)", "  "]) {
      expect(isNonSpeechCue(t), t).toBe(true);
    }
  });
  it("keeps real speech and mixed cues", () => {
    for (const t of ["hello world.", "(laughs) that's funny", "so [Music] then we", "a (side note) here"]) {
      expect(isNonSpeechCue(t), t).toBe(false);
    }
  });
});

describe("clampRange", () => {
  it("keeps a trim inside the source with a minimum and maximum length", () => {
    expect(clampRange(-5000, 3000, 600_000)).toEqual({ startMs: 0, endMs: 5000 });
    expect(clampRange(590_000, 700_000, 600_000)).toEqual({ startMs: 590_000, endMs: 600_000 });
    expect(clampRange(0, 400_000, 600_000)).toEqual({ startMs: 0, endMs: 180_000 });
  });
});

describe("captionFromText", () => {
  it("keeps the first two sentences", () => {
    expect(captionFromText("First one. Second one! Third one.")).toBe("First one. Second one!");
  });
  it("truncates long text at a word boundary", () => {
    const out = captionFromText("word ".repeat(100));
    expect(out.length).toBeLessThanOrEqual(221);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("platformOfPreset", () => {
  it("maps platform presets and ignores generic ratios", () => {
    expect(platformOfPreset(presetById("tiktok-9x16-1080")!)).toBe("tiktok");
    expect(platformOfPreset(presetById("ig-reels-9x16-1080")!)).toBe("instagram");
    expect(platformOfPreset(presetById("shorts-9x16-1080")!)).toBe("youtube");
    expect(platformOfPreset(presetById("ar-9x16")!)).toBeNull();
  });
});

describe("reframeKeyframes", () => {
  it("follows the subject: x moves opposite to the focus offset", () => {
    const k = reframeKeyframes(
      [
        { tMs: 0, cx: 0.3, cy: 0.5 },
        { tMs: 1000, cx: 0.7, cy: 0.5 },
      ],
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
    );
    expect(k.x).toHaveLength(2);
    expect(k.x[0]!.v).toBeGreaterThan(0);
    expect(k.x[1]!.v).toBeLessThan(0);
    expect(k.base.x).toBeCloseTo(0, 5);
    expect(k.base.scale).toBeGreaterThan(1);
  });
});

describe("buildClipDoc", () => {
  const cues = [
    cue("a", 100_000, 106_000, "Why does this matter?"),
    cue("b", 106_000, 112_000, "Because it changes everything."),
    cue("z", 500_000, 505_000, "unrelated."),
  ];
  const style = SUBTITLE_PRESETS.find((p) => p.id === "bold-social")!.style;

  const build = (over: Partial<Parameters<typeof buildClipDoc>[0]> = {}) =>
    buildClipDoc({
      base: base(),
      asset: ASSET,
      startMs: 99_900,
      endMs: 112_300,
      cues,
      presetIds: DEFAULT_TARGET_IDS,
      captions: true,
      captionStyle: style,
      ...over,
    });

  it("places the source window on a fresh 9:16 master", () => {
    const { doc, clipId } = build();
    expect(doc.canvas).toMatchObject({ width: 1080, height: 1920 });
    const clip = doc.timeline.tracks[0]!.clips.find((c) => c.id === clipId)!;
    expect(clip.startMs).toBe(0);
    expect(clip.sourceInMs).toBe(99_900);
    expect(Math.abs(clip.durationMs - 12_400)).toBeLessThan(40); // frame-snapped
    expect(clip.transform.scaleX).toBeGreaterThan(1); // 16:9 → 9:16 cover
    expect(doc.mediaRefs).toEqual([{ assetId: "a1", path: "/m/long.mp4", hash: null }]);
  });

  it("creates one version per extra target and none for the master", () => {
    const { doc, versionByPreset } = build();
    expect(versionByPreset["tiktok-9x16-1080"]).toBeNull();
    expect(doc.versions.map((v) => v.presetId)).toEqual(["ig-reels-9x16-1080", "shorts-9x16-1080"]);
    for (const v of doc.versions) {
      expect(Object.keys(v.clipOverrides)).toHaveLength(1);
      expect(v.canvas).toMatchObject({ width: 1080, height: 1920 });
    }
  });

  it("re-times captions to the clip and applies the caption style", () => {
    const { doc } = build();
    expect(doc.subtitles.map((c) => c.text)).toEqual(["Why does this matter?", "Because it changes everything."]);
    expect(doc.subtitles[0]!.startMs).toBe(100);
    expect(doc.subtitleStyle.mode).toBe("pop");
  });

  it("leaves captions out when disabled and does not mutate the input doc", () => {
    const input = base();
    const out = buildClipDoc({
      base: input,
      asset: ASSET,
      startMs: 0,
      endMs: 20_000,
      cues,
      presetIds: ["yt-16x9-1080"],
      captions: false,
      captionStyle: style,
    });
    expect(out.doc.subtitles).toEqual([]);
    expect(out.doc.versions).toEqual([]);
    expect(input.timeline.tracks).toHaveLength(0);
    expect(input.mediaRefs).toHaveLength(0);
  });

  it("bakes subject-following keyframes into master and versions when motion is given", () => {
    const motion = [
      { tMs: 0, cx: 0.3, cy: 0.5 },
      { tMs: 6000, cx: 0.7, cy: 0.5 },
    ];
    const { doc, clipId } = build({ motion });
    const clip = doc.timeline.tracks[0]!.clips.find((c) => c.id === clipId)!;
    expect(clip.keyframes["transform.x"]).toHaveLength(2);
    for (const v of doc.versions) {
      expect(v.clipOverrides[clipId]!.keyframes!["transform.x"]).toHaveLength(2);
    }
  });

  it("rejects an empty target list", () => {
    expect(() => build({ presetIds: [] })).toThrow();
  });
});
