/**
 * Effects-catalog audit — every tile in the Effects bin must DO something.
 *
 * History: the catalog grew fast and several tiles silently degraded —
 * contrast exported an identity curve, pulse ballooned to ~14× scale,
 * textFx presets produced no timeline strip, and all color effects
 * dropped at the same 0.25 so they looked identical. This suite walks
 * every catalog entry and asserts it produces a real, non-neutral change
 * on a synthetic clip.
 *
 * ffmpeg-side parity (contrast → lutrgb, all 35 xfade names rendering a
 * real mid-transition frame) is verified in `qa/fxaudit/run.sh` +
 * `merge.sh` and the Rust tests in render/effects.rs.
 */
import { describe, expect, it } from "vitest";
import { FX_CATALOG } from "@/modules/editor/EffectsBin";
import { ANIM_PRESETS, animPreset } from "@/lib/anim-presets";
import {
  EFFECTS,
  AUDIO_EFFECTS,
  EFFECT_DROP_PARAMS,
  cssFilterFor,
  svgFilterFragmentFor,
  boxShadowFor,
  overlayFor,
  evalKeyframes,
} from "@/lib/effects";
import {
  applyAnimationPreset,
  addGeneratedClip,
  addClip,
  findClip,
} from "@/lib/timeline-engine";
import type { Effect, ProjectDoc } from "@/lib/project-types";
import { DEFAULT_SUBTITLE_STYLE } from "@/lib/project-types";

/** ffmpeg xfade transition names — mirror of plan.rs::XFADES plus the
    legacy aliases dipToBlack/dipToWhite/crossfade. A catalog merge id not
    in this set degrades to plain "fade" on export (would look generic). */
const KNOWN_XFADES = new Set([
  "fade", "fadeblack", "fadewhite", "crossfade", "dipToBlack", "dipToWhite",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "wipetl", "wipetr", "wipebl", "wipebr",
  "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "coverleft", "coverright", "coverup", "coverdown",
  "revealleft", "revealright", "revealup", "revealdown",
  "circleopen", "circleclose", "circlecrop", "radial", "rectcrop",
  "dissolve", "pixelize", "hblur", "zoomin", "fadegrays",
  "diagtl", "diagtr", "diagbl", "diagbr",
  "hlslice", "hrslice", "vuslice", "vdslice",
  "hlwind", "hrwind", "vuwind", "vdwind",
  "squeezeh", "squeezev",
  "vertopen", "vertclose", "horzopen", "horzclose",
  "distance",
]);

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
  } as ProjectDoc;
}

const allItems = FX_CATALOG.flatMap((cat) =>
  cat.items.map((item) => ({ cat: cat.id, id: item.id })),
);

/** doc with one 3s media clip on a video track. */
const withMediaClip = () =>
  addClip(doc(), { trackKind: "video", mediaRef: "a1", startMs: 0, durationMs: 3000 });

describe("fx catalog audit", () => {
  it("catalog has no duplicate ids", () => {
    const ids = allItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every tile resolves to a known primitive", () => {
    for (const { cat, id } of allItems) {
      if (cat === "merge") {
        expect(KNOWN_XFADES.has(id), `merge '${id}' is not an ffmpeg xfade`).toBe(true);
      } else {
        const known = animPreset(id) !== undefined || EFFECTS.some((e) => e.type === id);
        expect(known, `'${id}' in '${cat}' resolves to nothing`).toBe(true);
      }
    }
  });

  it("overlay effect ids never collide with audio effect ids", () => {
    for (const e of EFFECTS)
      expect(
        AUDIO_EFFECTS.some((a) => a.type === e.type),
        `'${e.type}' collides with an audio effect — effectDef() ambiguous`,
      ).toBe(false);
  });

  it("every overlay effect produces a non-neutral preview at drop params", () => {
    for (const def of EFFECTS) {
      const params = Object.fromEntries(
        Object.entries(def.params).map(([k, s]) => [
          k,
          EFFECT_DROP_PARAMS[def.type]?.[k] ?? s.def,
        ]),
      );
      const fx = { id: "e", type: def.type, enabled: true, params } as Effect;
      const out =
        cssFilterFor([fx]) ||
        svgFilterFragmentFor([fx]) ||
        boxShadowFor([fx]) ||
        overlayFor([fx]) ||
        "";
      if (!def.noPreview) {
        expect(out.length, `'${def.type}' produces no preview at drop params`).toBeGreaterThan(0);
      }
      if (def.noPreview) continue;
      const neutral =
        /brightness\(1(\.0*)?\)|contrast\(1(\.0*)?\)|saturate\(1(\.0*)?\)|blur\(0(\.0*)?px\)|grayscale\(0(\.0*)?\)|sepia\(0(\.0*)?\)|invert\(0(\.0*)?\)|hue-rotate\(0(\.0*)?deg\)/;
      expect(neutral.test(out), `'${def.type}' preview is neutral: ${out}`).toBe(false);
    }
  });

  it("every anim preset produces real output", () => {
    for (const p of ANIM_PRESETS) {
      const isTextFx = p.paths.length === 0;
      let clipId: string;
      let d: ProjectDoc;
      if (isTextFx) {
        const r = addGeneratedClip(doc(), "text", {
          startMs: 0,
          durationMs: 3000,
          text: "Hello world",
        });
        d = r.doc;
        clipId = r.clipId;
      } else {
        const r = withMediaClip();
        d = r.doc;
        clipId = r.clipId;
      }
      const d1 = applyAnimationPreset(d, clipId, p.id, { durationMs: 500 });
      const clip = findClip(d1, clipId)!.clip;
      if (isTextFx) {
        expect(clip.textFx, `'${p.id}' set no textFx`).toBeTruthy();
      } else {
        const paths = Object.keys(clip.keyframes);
        expect(paths.length, `'${p.id}' baked no keyframes`).toBeGreaterThan(0);
        const varies = p.paths.some((path) => {
          const kfs = clip.keyframes[path] ?? [];
          return kfs.some((k) => k.v !== kfs[0]?.v);
        });
        expect(varies, `'${p.id}' keyframes are flat`).toBe(true);
        for (const arr of Object.values(clip.keyframes))
          for (const k of arr) {
            expect(k.tMs, `'${p.id}' keyframe at ${k.tMs}ms out of clip`).toBeGreaterThanOrEqual(0);
            expect(k.tMs).toBeLessThanOrEqual(clip.durationMs + 2);
            expect(k.anim, `'${p.id}' keyframe missing anim tag`).toBe(p.id);
          }
      }
    }
  });

  it("emphasis presets stay sane — pulse ~8%, shake ~20px, float ~19px", () => {
    const mk = (id: string) => {
      const r = withMediaClip();
      const dd = applyAnimationPreset(r.doc, r.clipId, id, { durationMs: 3000 });
      return findClip(dd, r.clipId)!.clip;
    };
    const pulse = mk("pulse");
    expect(Math.max(...pulse.keyframes["transform.scaleX"].map((k) => k.v))).toBeLessThanOrEqual(1.15);
    const shake = mk("shake");
    expect(
      Math.max(...shake.keyframes["transform.x"].map((k) => Math.abs(k.v - shake.transform.x))),
    ).toBeLessThanOrEqual(30);
    const float = mk("float");
    expect(
      Math.max(...float.keyframes["transform.y"].map((k) => Math.abs(k.v - float.transform.y))),
    ).toBeLessThanOrEqual(25);
  });

  it("in presets converge back to the clip's base transform", () => {
    for (const p of ANIM_PRESETS.filter((x) => x.category === "in" && x.paths.length)) {
      const r = withMediaClip();
      const dd = applyAnimationPreset(r.doc, r.clipId, p.id, { durationMs: 500 });
      const clip = findClip(dd, r.clipId)!.clip;
      for (const path of p.paths) {
        const kfs = clip.keyframes[path];
        if (!kfs) continue;
        const last = evalKeyframes(kfs, clip.durationMs, 0);
        const base =
          path === "transform.x" ? clip.transform.x
          : path === "transform.y" ? clip.transform.y
          : path === "transform.scaleX" ? clip.transform.scaleX
          : path === "transform.scaleY" ? clip.transform.scaleY
          : path === "transform.rotationDeg" ? clip.transform.rotationDeg
          : clip.transform.opacity;
        expect(last, `'${p.id}' ${path} does not return to base`).toBeCloseTo(base, 4);
      }
    }
  });

  it("overlay anim tiles route to keyframe-capable presets", () => {
    const overlayCat = FX_CATALOG.find((c) => c.id === "overlay")!;
    for (const tile of overlayCat.items) {
      const p = animPreset(tile.id);
      if (!p) continue; // real overlay effects handled above
      expect(["transition", "emphasis", "loop"]).toContain(p.category);
      expect(p.paths.length, `overlay preset '${p.id}' is textFx-only`).toBeGreaterThan(0);
    }
  });
});
