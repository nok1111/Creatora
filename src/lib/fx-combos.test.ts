/**
 * Creative-combo tests — a combo drop must land as independent, editable
 * primitives: manifest effects in clip.effects[] with correct windows,
 * anim presets as their own tagged keyframes. Nothing baked.
 */
import { describe, expect, it } from "vitest";
import { applyCombo, COMBO_PRESETS, comboPreset } from "@/lib/fx-combos";
import { addClip, findClip } from "@/lib/timeline-engine";
import { fxEntry } from "@/lib/fx/manifest";
import { animPreset } from "@/lib/anim-presets";
import type { ProjectDoc } from "@/lib/project-types";
import { DEFAULT_SUBTITLE_STYLE } from "@/lib/project-types";

function doc(): ProjectDoc {
  return {
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
  } as ProjectDoc;
}

const withClip = () =>
  addClip(doc(), { trackKind: "video", mediaRef: "a1", startMs: 0, durationMs: 3000 });

describe("combo presets", () => {
  it("every combo step resolves to a manifest entry or an anim preset", () => {
    for (const c of COMBO_PRESETS)
      for (const s of c.steps) {
        const ok = fxEntry(s.id) !== undefined || animPreset(s.id) !== undefined;
        expect(ok, `${c.id} → '${s.id}' resolves to nothing`).toBe(true);
      }
  });

  it("combos respect the design budget (≤1 window edge, ≤2 look layers)", () => {
    for (const c of COMBO_PRESETS) {
      const starts = c.steps.filter((s) => s.window === "start").length;
      const ends = c.steps.filter((s) => s.window === "end").length;
      expect(starts, `${c.id} has two start windows`).toBeLessThanOrEqual(1);
      expect(ends, `${c.id} has two end windows`).toBeLessThanOrEqual(1);
      const looks = c.steps.filter((s) => {
        const e = fxEntry(s.id);
        return e && (e.kind === "filter" || e.category === "light");
      }).length;
      expect(looks, `${c.id} stacks too many look layers`).toBeLessThanOrEqual(2);
    }
  });

  it("applies a start-window combo as individual effects", () => {
    const r = withClip();
    const clip = findClip(r.doc, r.clipId)!.clip;
    const { doc: d, applied } = applyCombo(r.doc, clip, "cinematicIn");
    expect(applied).toBe(2);
    const out = findClip(d, r.clipId)!.clip;
    expect(out.effects.length).toBe(2);
    const fp = out.effects.find((e) => e.type === "focusPull")!;
    const dur = fxEntry("focusPull")!.params.find((p) => p.key === "duration")!.def;
    expect(fp.inMs).toBe(0);
    expect(fp.outMs).toBe(Math.min(dur, clip.durationMs));
    const grade = out.effects.find((e) => e.type === "goldenFilm")!;
    expect(grade.inMs).toBe(0);
    // every step is its own effect entry → independently removable
    expect(new Set(out.effects.map((e) => e.id)).size).toBe(2);
  });

  it("applies an end-window combo anchored to the clip end", () => {
    const r = withClip();
    const clip = findClip(r.doc, r.clipId)!.clip;
    const { doc: d } = applyCombo(r.doc, clip, "dramaticExit");
    const out = findClip(d, r.clipId)!.clip;
    const burn = out.effects.find((e) => e.type === "filmBurn")!;
    const dur = fxEntry("filmBurn")!.params.find((p) => p.key === "duration")!.def;
    const wMs = Math.min(dur, clip.durationMs);
    expect(burn.inMs).toBe(clip.durationMs - wMs);
    expect(burn.outMs).toBeUndefined();
  });

  it("bakes anim-preset steps as tagged keyframes", () => {
    const r = withClip();
    const clip = findClip(r.doc, r.clipId)!.clip;
    const { doc: d } = applyCombo(r.doc, clip, "dreamHaze", { durationMs: 500 });
    const out = findClip(d, r.clipId)!.clip;
    const tagged = Object.values(out.keyframes)
      .flat()
      .filter((k) => k.anim === "scaleIn");
    expect(tagged.length).toBeGreaterThan(0);
    expect(out.effects.some((e) => e.type === "dreamy")).toBe(true);
    expect(out.effects.some((e) => e.type === "floatingDust")).toBe(true);
  });

  it("respects the 3-active-filter cap", () => {
    const r = withClip();
    let d = r.doc;
    const clip = findClip(d, r.clipId)!.clip;
    clip.effects = [
      { id: "1", type: "luxury", enabled: true, params: {} },
      { id: "2", type: "softGlow", enabled: true, params: {} },
      { id: "3", type: "monochrome", enabled: true, params: {} },
    ];
    const res = applyCombo(d, clip, "cinematicIn");
    const out = findClip(res.doc, r.clipId)!.clip;
    // focusPull applies, goldenFilm skipped → +1 effect only
    expect(out.effects.filter((e) => e.type === "goldenFilm").length).toBe(0);
    expect(out.effects.filter((e) => e.type === "focusPull").length).toBe(1);
    expect(res.applied).toBe(1);
  });

  it("unknown ids are a no-op", () => {
    const r = withClip();
    const clip = findClip(r.doc, r.clipId)!.clip;
    const res = applyCombo(r.doc, clip, "nopeNotACombo");
    expect(res.applied).toBe(0);
    expect(res.doc).toBe(r.doc);
  });

  it("comboPreset lookup is exact — no partial matches", () => {
    expect(comboPreset("cinematicIn")).toBeTruthy();
    expect(comboPreset("cinematic")).toBeUndefined();
    expect(comboPreset("goldenFilm")).toBeUndefined();
  });
});
