/**
 * Animation preset catalog (ADR-027).
 *
 * Every preset produces REAL render output: transform/opacity presets
 * bake eased samples into the clip's canonical keyframes (render's
 * piecewise-linear eval ≈ the curve); `typewriter`/`wipe` set `clip.textFx`
 * which the render emits as extra drawtext/geq work on the layer.
 * Nothing here is preview-only.
 */

import type { Clip, Keyframe, ProjectDoc, TextFx } from "@/lib/project-types";

export type Easing = "linear" | "easeOut" | "easeIn" | "easeInOut" | "backOut" | "bounceOut";

const EASE: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  easeIn: (t) => t * t * t,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  backOut: (t) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
  bounceOut: (t) => {
    const n = 7.5625,
      d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

/** Bake `from→to` over [t0,t0+dur] into keyframes (N eased samples). */
export function bakeKfs(
  t0: number,
  durMs: number,
  from: number,
  to: number,
  easing: Easing,
  samples = 10,
): Keyframe[] {
  const f = EASE[easing] ?? EASE.linear;
  const out: Keyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    out.push({
      tMs: Math.round(t0 + u * durMs),
      v: from + (to - from) * f(u),
      ease: "linear",
    });
  }
  return out;
}

export interface AnimPreset {
  id: string;
  label: string;
  category: "in" | "out" | "emphasis" | "loop" | "transition";
  /** keyframe paths this preset owns (replaced on apply) */
  paths: string[];
  build: (
    clip: Clip,
    canvas: { width: number; height: number },
    o: { durationMs: number; delayMs: number; intensity: number; direction: string; easing: Easing },
  ) => { keyframes: Record<string, Keyframe[]>; textFx?: TextFx | null };
}

export const ANIM_PRESETS: AnimPreset[] = [
  {
    id: "fadeIn",
    label: "Fade in",
    category: "in",
    paths: ["transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: { "transform.opacity": bakeKfs(o.delayMs, o.durationMs, 0, c.transform.opacity, o.easing) },
    }),
  },
  {
    id: "fadeOut",
    label: "Fade out",
    category: "out",
    paths: ["transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.opacity": bakeKfs(
          Math.max(0, c.durationMs - o.durationMs),
          o.durationMs,
          c.transform.opacity,
          0,
          o.easing,
        ),
      },
    }),
  },
  {
    id: "slideIn",
    label: "Slide in",
    category: "in",
    paths: ["transform.x", "transform.y"],
    build: (c, cv, o) => {
      const t = c.transform;
      const k: Record<string, Keyframe[]> = {};
      const off = o.intensity;
      if (o.direction === "up") k["transform.y"] = bakeKfs(o.delayMs, o.durationMs, t.y + off, t.y, o.easing);
      else if (o.direction === "down") k["transform.y"] = bakeKfs(o.delayMs, o.durationMs, t.y - off, t.y, o.easing);
      else if (o.direction === "right") k["transform.x"] = bakeKfs(o.delayMs, o.durationMs, t.x - off, t.x, o.easing);
      else k["transform.x"] = bakeKfs(o.delayMs, o.durationMs, t.x + off, t.x, o.easing);
      void cv;
      return { keyframes: k };
    },
  },
  {
    id: "slideOut",
    label: "Slide out",
    category: "out",
    paths: ["transform.x", "transform.y"],
    build: (c, _cv, o) => {
      const t = c.transform;
      const t0 = Math.max(0, c.durationMs - o.durationMs);
      const off = o.intensity;
      const k: Record<string, Keyframe[]> = {};
      if (o.direction === "up") k["transform.y"] = bakeKfs(t0, o.durationMs, t.y, t.y - off, o.easing);
      else if (o.direction === "down") k["transform.y"] = bakeKfs(t0, o.durationMs, t.y, t.y + off, o.easing);
      else if (o.direction === "right") k["transform.x"] = bakeKfs(t0, o.durationMs, t.x, t.x + off, o.easing);
      else k["transform.x"] = bakeKfs(t0, o.durationMs, t.x, t.x - off, o.easing);
      return { keyframes: k };
    },
  },
  {
    id: "scaleIn",
    label: "Scale in (pop)",
    category: "in",
    paths: ["transform.scaleX", "transform.scaleY", "transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.scaleX": bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleX, o.easing),
        "transform.scaleY": bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleY, o.easing),
        "transform.opacity": bakeKfs(o.delayMs, Math.min(o.durationMs, 200), 0, c.transform.opacity, "easeOut"),
      },
    }),
  },
  {
    id: "rotateIn",
    label: "Rotate in",
    category: "in",
    paths: ["transform.rotationDeg", "transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.rotationDeg": bakeKfs(o.delayMs, o.durationMs, -90, c.transform.rotationDeg, o.easing),
        "transform.opacity": bakeKfs(o.delayMs, Math.min(o.durationMs, 250), 0, c.transform.opacity, "easeOut"),
      },
    }),
  },
  {
    id: "typewriter",
    label: "Typewriter",
    category: "in",
    paths: [],
    build: (_c, _cv, o) => ({
      keyframes: {},
      textFx: { kind: "typewriter", rate: 1000 / Math.max(30, o.durationMs / 10), direction: "", durationMs: 0 },
    }),
  },
  {
    id: "typewriterOut",
    label: "Typewriter out",
    category: "out",
    paths: [],
    build: (_c, _cv, o) => ({
      keyframes: {},
      textFx: { kind: "typewriter", rate: 1000 / Math.max(30, o.durationMs / 10), direction: "", durationMs: 0, out: true },
    }),
  },
  {
    id: "wipe",
    label: "Wipe reveal",
    category: "in",
    paths: [],
    build: (_c, _cv, o) => ({
      keyframes: {},
      textFx: {
        kind: "wipe",
        rate: 0,
        direction: o.direction === "right" ? "ltr" : o.direction === "up" ? "btt" : o.direction === "down" ? "ttb" : "ltr",
        durationMs: o.durationMs,
      },
    }),
  },
  {
    id: "wipeOut",
    label: "Wipe out",
    category: "out",
    paths: [],
    build: (_c, _cv, o) => ({
      keyframes: {},
      textFx: {
        kind: "wipe",
        rate: 0,
        direction: o.direction === "right" ? "ltr" : o.direction === "up" ? "btt" : o.direction === "down" ? "ttb" : "ltr",
        durationMs: o.durationMs,
        out: true,
      },
    }),
  },
  {
    id: "blurIn",
    label: "Blur reveal",
    category: "in",
    paths: [],
    build: (_c, _cv, o) => ({
      keyframes: {},
      textFx: { kind: "blur", rate: 12, direction: "", durationMs: o.durationMs },
    }),
  },
  {
    id: "blurOut",
    label: "Blur dissolve",
    category: "out",
    paths: [],
    build: (_c, _cv, o) => ({
      keyframes: {},
      textFx: { kind: "blur", rate: 12, direction: "", durationMs: o.durationMs, out: true },
    }),
  },
  {
    id: "fadeInOut",
    label: "Fade in+out",
    category: "transition",
    paths: ["transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.opacity": [
          ...bakeKfs(o.delayMs, o.durationMs, 0, c.transform.opacity, o.easing, 6),
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.opacity, 0, o.easing, 6).slice(1),
        ],
      },
    }),
  },
  {
    id: "slideInOut",
    label: "Slide in+out",
    category: "transition",
    paths: ["transform.x"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.x": [
          ...bakeKfs(o.delayMs, o.durationMs, c.transform.x + o.intensity, c.transform.x, o.easing, 6),
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.x, c.transform.x - o.intensity, o.easing, 6).slice(1),
        ],
      },
    }),
  },
  {
    id: "scaleInOut",
    label: "Pop in+out",
    category: "transition",
    paths: ["transform.scaleX", "transform.scaleY"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.scaleX": [
          ...bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleX, o.easing, 6),
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.scaleX, 0.01, o.easing, 6).slice(1),
        ],
        "transform.scaleY": [
          ...bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleY, o.easing, 6),
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.scaleY, 0.01, o.easing, 6).slice(1),
        ],
      },
    }),
  },
  {
    id: "pulse",
    label: "Pulse",
    category: "emphasis",
    paths: ["transform.scaleX", "transform.scaleY"],
    build: (c, _cv, o) => {
      const s = c.transform.scaleX * (1 + 0.08 * o.intensity);
      return {
        keyframes: {
          "transform.scaleX": [
            ...bakeKfs(o.delayMs, o.durationMs / 2, c.transform.scaleX, s, "easeOut", 4),
            ...bakeKfs(o.delayMs + o.durationMs / 2, o.durationMs / 2, s, c.transform.scaleX, "easeIn", 4).slice(1),
          ],
          "transform.scaleY": [
            ...bakeKfs(o.delayMs, o.durationMs / 2, c.transform.scaleY, c.transform.scaleY * (1 + 0.08 * o.intensity), "easeOut", 4),
            ...bakeKfs(o.delayMs + o.durationMs / 2, o.durationMs / 2, c.transform.scaleY * (1 + 0.08 * o.intensity), c.transform.scaleY, "easeIn", 4).slice(1),
          ],
        },
      };
    },
  },
  {
    id: "shake",
    label: "Shake",
    category: "emphasis",
    paths: ["transform.x"],
    build: (c, _cv, o) => {
      const kfs: Keyframe[] = [{ tMs: o.delayMs, v: c.transform.x, ease: "linear" }];
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const amp = o.intensity * (1 - i / (steps + 1));
        kfs.push({
          tMs: Math.round(o.delayMs + (i / steps) * o.durationMs),
          v: c.transform.x + (i % 2 ? amp : -amp),
          ease: "linear",
        });
      }
      kfs.push({ tMs: Math.round(o.delayMs + o.durationMs + 1), v: c.transform.x, ease: "linear" });
      return { keyframes: { "transform.x": kfs } };
    },
  },
  {
    id: "float",
    label: "Float (loop)",
    category: "loop",
    paths: ["transform.y"],
    build: (c, _cv, o) => {
      // 3 full sine-ish cycles sampled over the clip duration.
      const kfs: Keyframe[] = [];
      const cycles = 3;
      const n = cycles * 8;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        kfs.push({
          tMs: Math.round(u * c.durationMs),
          v: c.transform.y + Math.sin(u * cycles * Math.PI * 2) * o.intensity,
          ease: "linear",
        });
      }
      return { keyframes: { "transform.y": kfs } };
    },
  },
];

export function animPreset(id: string): AnimPreset | undefined {
  return ANIM_PRESETS.find((p) => p.id === id);
}

/** Merge built keyframes into the clip — preset OWNS its paths. */
export function mergePresetKeyframes(clip: Clip, built: Record<string, Keyframe[]>): Clip {
  const kf = { ...clip.keyframes };
  for (const [path, kfs] of Object.entries(built)) kf[path] = kfs;
  return { ...clip, keyframes: kf };
}

/** Does this doc's clip accept text_fx? (typewriter/wipe need the text layer) */
export function supportsTextFx(doc: ProjectDoc, clipId: string): boolean {
  for (const t of doc.timeline.tracks)
    if ((t.kind === "text" || t.kind === "graphics") && t.clips.some((c) => c.id === clipId)) return true;
  return false;
}
