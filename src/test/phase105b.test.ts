import { describe, it, expect, beforeEach } from "vitest";
import { useEditor } from "@/stores/editor";
import { useProject } from "@/stores/project";
import { addTrack, addClip, updateClip, upsertDuckingRule, setDocBrandKit } from "@/lib/timeline-engine";
import type { ProjectDoc } from "@/lib/project-types";
import { DEFAULT_SUBTITLE_STYLE } from "@/lib/project-types";

function doc(): ProjectDoc {
  let d: ProjectDoc = {
    formatVersion: 1,
    meta: { id: "p1", name: "t", createdAt: "x", modifiedAt: "x", creatoraVersion: "0" },
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
  d = addTrack(d, "video").doc;
  const r = addClip(d, { mediaRef: "a1", startMs: 0, durationMs: 1000 });
  return r.doc;
}

beforeEach(() => {
  useProject.getState().setDoc(doc());
  useEditor.setState({ past: [], future: [], gestureBase: null, selection: [] });
});

const clipId = (d: ProjectDoc) => d.timeline.tracks[0].clips[0].id;

describe("gesture undo", () => {
  it("one gesture = one undo entry restoring exact transform", () => {
    const es = useEditor.getState();
    const id = clipId(useProject.getState().doc!);
    es.beginGesture();
    for (let i = 1; i <= 5; i++) {
      es.mutateInGesture((d) => updateClip(d, id, { transform: { x: i * 10 } }));
    }
    es.endGesture();
    expect(useProject.getState().doc!.timeline.tracks[0].clips[0].transform.x).toBe(50);
    expect(useEditor.getState().past.length).toBe(1);
    useEditor.getState().undo();
    expect(useProject.getState().doc!.timeline.tracks[0].clips[0].transform.x).toBe(0);
    useEditor.getState().redo();
    expect(useProject.getState().doc!.timeline.tracks[0].clips[0].transform.x).toBe(50);
  });

  it("no-op gesture creates no undo entry", () => {
    const es = useEditor.getState();
    es.beginGesture();
    es.endGesture();
    expect(useEditor.getState().past.length).toBe(0);
  });
});

describe("ducking rules", () => {
  it("upsert creates then updates the same rule by id", () => {
    const d = doc();
    const r = { id: "r1", sourceTrack: "t1", targetTrack: "t2", thresholdDb: -30,
      reductionDb: -12, attackMs: 80, releaseMs: 400, holdMs: 150 };
    const d2 = upsertDuckingRule(d, r);
    expect(d2.ducking).toHaveLength(1);
    const d3 = upsertDuckingRule(d2, { ...r, reductionDb: -18 });
    expect(d3.ducking).toHaveLength(1);
    expect(d3.ducking[0].reductionDb).toBe(-18);
    expect(d3.ducking[0].sourceTrack).toBe("t1");
  });
});

describe("brand kit application", () => {
  it("setting a kit preserves kit data and toggles cleanly", () => {
    const d = doc();
    const kit = { id: "k1", name: "Acme", colors: ["#FF795E"], fonts: [], logos: [],
      titleStyle: DEFAULT_SUBTITLE_STYLE.text };
    const d2 = setDocBrandKit(d, kit as never);
    expect(d2.brandKitId).toBe("k1");
    expect(d2.brandKit?.colors).toEqual(["#FF795E"]);
    const d3 = setDocBrandKit(d2, null);
    expect(d3.brandKitId).toBeNull();
    expect(kit.name).toBe("Acme"); // source object untouched
  });
});
