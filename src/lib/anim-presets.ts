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
    paths: ["transform.opacity", "transform.scaleX", "transform.scaleY"],
    // A bare opacity ramp reads flat; a 3% settle gives the frame depth.
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.opacity": bakeKfs(o.delayMs, o.durationMs, 0, c.transform.opacity, o.easing),
        "transform.scaleX": bakeKfs(o.delayMs, o.durationMs, c.transform.scaleX * 0.97, c.transform.scaleX, o.easing),
        "transform.scaleY": bakeKfs(o.delayMs, o.durationMs, c.transform.scaleY * 0.97, c.transform.scaleY, o.easing),
      },
    }),
  },
  {
    id: "fadeOut",
    label: "Fade out",
    category: "out",
    paths: ["transform.opacity", "transform.scaleX", "transform.scaleY"],
    // Exits accelerate away (easeIn) — a decelerating exit feels like it hangs.
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.opacity": bakeKfs(
          Math.max(0, c.durationMs - o.durationMs),
          o.durationMs,
          c.transform.opacity,
          0,
          "easeIn",
        ),
        "transform.scaleX": bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.scaleX, c.transform.scaleX * 0.97, "easeIn"),
        "transform.scaleY": bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.scaleY, c.transform.scaleY * 0.97, "easeIn"),
      },
    }),
  },
  {
    id: "slideIn",
    label: "Slide in",
    category: "in",
    paths: ["transform.x", "transform.y", "transform.opacity"],
    // backOut overshoots a hair past the rest position — "arrive and
    // settle" instead of a panel gliding to a stop; a fade over the
    // first 40% keeps the travel from reading as a hard wipe.
    build: (c, cv, o) => {
      const t = c.transform;
      const k: Record<string, Keyframe[]> = {};
      const off = o.intensity;
      if (o.direction === "up") k["transform.y"] = bakeKfs(o.delayMs, o.durationMs, t.y + off, t.y, "backOut");
      else if (o.direction === "down") k["transform.y"] = bakeKfs(o.delayMs, o.durationMs, t.y - off, t.y, "backOut");
      else if (o.direction === "right") k["transform.x"] = bakeKfs(o.delayMs, o.durationMs, t.x - off, t.x, "backOut");
      else k["transform.x"] = bakeKfs(o.delayMs, o.durationMs, t.x + off, t.x, "backOut");
      k["transform.opacity"] = bakeKfs(o.delayMs, o.durationMs * 0.4, 0, t.opacity, "easeOut");
      void cv;
      return { keyframes: k };
    },
  },
  {
    id: "slideOut",
    label: "Slide out",
    category: "out",
    paths: ["transform.x", "transform.y", "transform.opacity"],
    // easeIn accelerates the clip out of frame; the fade covers the
    // last 40% so the exit dissolves instead of clipping a hard edge.
    build: (c, _cv, o) => {
      const t = c.transform;
      const t0 = Math.max(0, c.durationMs - o.durationMs);
      const off = o.intensity;
      const k: Record<string, Keyframe[]> = {};
      if (o.direction === "up") k["transform.y"] = bakeKfs(t0, o.durationMs, t.y, t.y - off, "easeIn");
      else if (o.direction === "down") k["transform.y"] = bakeKfs(t0, o.durationMs, t.y, t.y + off, "easeIn");
      else if (o.direction === "right") k["transform.x"] = bakeKfs(t0, o.durationMs, t.x, t.x + off, "easeIn");
      else k["transform.x"] = bakeKfs(t0, o.durationMs, t.x, t.x - off, "easeIn");
      k["transform.opacity"] = bakeKfs(t0 + o.durationMs * 0.6, o.durationMs * 0.4, t.opacity, 0, "easeIn");
      return { keyframes: k };
    },
  },
  {
    id: "scaleIn",
    label: "Scale in (pop)",
    category: "in",
    paths: ["transform.scaleX", "transform.scaleY", "transform.opacity"],
    // backOut: a "pop" without overshoot is just a zoom — the ~10%
    // overshoot before the settle is what makes it read as a pop.
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.scaleX": bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleX, "backOut"),
        "transform.scaleY": bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleY, "backOut"),
        "transform.opacity": bakeKfs(o.delayMs, Math.min(o.durationMs, 200), 0, c.transform.opacity, "easeOut"),
      },
    }),
  },
  {
    id: "rotateIn",
    label: "Rotate in",
    category: "in",
    paths: ["transform.rotationDeg", "transform.scaleX", "transform.scaleY", "transform.opacity"],
    // A card swinging in: slight grow + backOut overshoot on the
    // rotation so it lands with a settle, not a hard stop.
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.rotationDeg": bakeKfs(o.delayMs, o.durationMs, -90, c.transform.rotationDeg, "backOut"),
        "transform.scaleX": bakeKfs(o.delayMs, o.durationMs, c.transform.scaleX * 0.7, c.transform.scaleX, "backOut"),
        "transform.scaleY": bakeKfs(o.delayMs, o.durationMs, c.transform.scaleY * 0.7, c.transform.scaleY, "backOut"),
        "transform.opacity": bakeKfs(o.delayMs, Math.min(o.durationMs, 250), 0, c.transform.opacity, "easeOut"),
      },
    }),
  },
  {
    id: "bounceIn",
    label: "Bounce in",
    category: "in",
    paths: ["transform.scaleX", "transform.scaleY", "transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.scaleX": bakeKfs(o.delayMs, o.durationMs, 0.3, c.transform.scaleX, "bounceOut"),
        "transform.scaleY": bakeKfs(o.delayMs, o.durationMs, 0.3, c.transform.scaleY, "bounceOut"),
        "transform.opacity": bakeKfs(o.delayMs, Math.min(o.durationMs, 200), 0, c.transform.opacity, "easeOut"),
      },
    }),
  },
  {
    id: "spinIn",
    label: "Spin in",
    category: "in",
    paths: ["transform.rotationDeg", "transform.scaleX", "transform.scaleY", "transform.opacity"],
    build: (c, _cv, o) => ({
      keyframes: {
        "transform.rotationDeg": bakeKfs(o.delayMs, o.durationMs, c.transform.rotationDeg - 180, c.transform.rotationDeg, "backOut"),
        "transform.scaleX": bakeKfs(o.delayMs, o.durationMs, 0.3, c.transform.scaleX, "backOut"),
        "transform.scaleY": bakeKfs(o.delayMs, o.durationMs, 0.3, c.transform.scaleY, "backOut"),
        "transform.opacity": bakeKfs(o.delayMs, Math.min(o.durationMs, 200), 0, c.transform.opacity, "easeOut"),
      },
    }),
  },
  {
    id: "scaleOut",
    label: "Scale out",
    category: "out",
    paths: ["transform.scaleX", "transform.scaleY", "transform.opacity"],
    // easeIn: the shrink accelerates — the clip gets sucked away
    // instead of easing to a stop at zero size.
    build: (c, _cv, o) => {
      const t0 = Math.max(0, c.durationMs - o.durationMs);
      return {
        keyframes: {
          "transform.scaleX": bakeKfs(t0, o.durationMs, c.transform.scaleX, 0.01, "easeIn"),
          "transform.scaleY": bakeKfs(t0, o.durationMs, c.transform.scaleY, 0.01, "easeIn"),
          "transform.opacity": bakeKfs(Math.max(0, c.durationMs - Math.min(o.durationMs, 250)), Math.min(o.durationMs, 250), c.transform.opacity, 0, "easeIn"),
        },
      };
    },
  },
  {
    id: "rotateOut",
    label: "Rotate out",
    category: "out",
    paths: ["transform.rotationDeg", "transform.scaleX", "transform.scaleY", "transform.opacity"],
    // Spins away with a slight shrink — accelerate (easeIn) so the
    // exit builds speed like a card flicked off screen.
    build: (c, _cv, o) => {
      const t0 = Math.max(0, c.durationMs - o.durationMs);
      return {
        keyframes: {
          "transform.rotationDeg": bakeKfs(t0, o.durationMs, c.transform.rotationDeg, c.transform.rotationDeg + 90, "easeIn"),
          "transform.scaleX": bakeKfs(t0, o.durationMs, c.transform.scaleX, c.transform.scaleX * 0.85, "easeIn"),
          "transform.scaleY": bakeKfs(t0, o.durationMs, c.transform.scaleY, c.transform.scaleY * 0.85, "easeIn"),
          "transform.opacity": bakeKfs(Math.max(0, c.durationMs - Math.min(o.durationMs, 250)), Math.min(o.durationMs, 250), c.transform.opacity, 0, "easeIn"),
        },
      };
    },
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
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.opacity, 0, "easeIn", 6).slice(1),
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
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.x, c.transform.x - o.intensity, "easeIn", 6).slice(1),
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
          ...bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleX, "backOut", 6),
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.scaleX, 0.01, "easeIn", 6).slice(1),
        ],
        "transform.scaleY": [
          ...bakeKfs(o.delayMs, o.durationMs, 0.01, c.transform.scaleY, "backOut", 6),
          ...bakeKfs(Math.max(0, c.durationMs - o.durationMs), o.durationMs, c.transform.scaleY, 0.01, "easeIn", 6).slice(1),
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
      // intensity is px-scaled (default 160) — normalize to a scale bump:
      // 160 → 8% grow. Raw 0.08*160 would balloon the clip ~14×.
      // Asymmetric like a heartbeat: fast 30% attack, slow 70% release —
      // a symmetric pulse reads as a slow zoom, not a beat hit.
      const sx = c.transform.scaleX * (1 + 0.08 * (o.intensity / 160));
      const sy = c.transform.scaleY * (1 + 0.08 * (o.intensity / 160));
      const hit = o.durationMs * 0.3;
      return {
        keyframes: {
          "transform.scaleX": [
            ...bakeKfs(o.delayMs, hit, c.transform.scaleX, sx, "easeOut", 3),
            ...bakeKfs(o.delayMs + hit, o.durationMs - hit, sx, c.transform.scaleX, "easeInOut", 6).slice(1),
          ],
          "transform.scaleY": [
            ...bakeKfs(o.delayMs, hit, c.transform.scaleY, sy, "easeOut", 3),
            ...bakeKfs(o.delayMs + hit, o.durationMs - hit, sy, c.transform.scaleY, "easeInOut", 6).slice(1),
          ],
        },
      };
    },
  },
  {
    id: "zoomPunch",
    label: "Zoom punch",
    category: "emphasis",
    paths: ["transform.scaleX", "transform.scaleY"],
    build: (c, _cv, o) => {
      // Fast punch to ~+14% and settle back — intensity normalizes like
      // pulse (160 → 14%): a beat hit, not a slow zoom.
      const s = 1 + 0.14 * (o.intensity / 160);
      const up = (from: number) =>
        bakeKfs(o.delayMs, o.durationMs * 0.35, from, from * s, "easeOut", 3);
      const down = (from: number) =>
        bakeKfs(o.delayMs + o.durationMs * 0.35, o.durationMs * 0.65, from * s, from, "easeInOut", 5).slice(1);
      return {
        keyframes: {
          "transform.scaleX": [...up(c.transform.scaleX), ...down(c.transform.scaleX)],
          "transform.scaleY": [...up(c.transform.scaleY), ...down(c.transform.scaleY)],
        },
      };
    },
  },
  {
    id: "shake",
    label: "Shake",
    category: "emphasis",
    paths: ["transform.x", "transform.rotationDeg"],
    build: (c, _cv, o) => {
      const steps = 8;
      const kfs: Keyframe[] = [{ tMs: o.delayMs, v: c.transform.x, ease: "linear" }];
      const rot: Keyframe[] = [{ tMs: o.delayMs, v: c.transform.rotationDeg, ease: "linear" }];
      for (let i = 1; i <= steps; i++) {
        // 15% of the px intensity — a punchy ~20px shake at the default,
        // not a 160px screen-wide fling. Deterministic jitter on the
        // decay keeps it physical — a perfectly alternating ramp is
        // what makes a shake look machine-generated.
        const decay = 1 - i / (steps + 1);
        const amp = o.intensity * 0.15 * decay * (i % 2 ? 1 : 0.82);
        const tMs = Math.round(o.delayMs + (i / steps) * o.durationMs);
        kfs.push({ tMs, v: c.transform.x + (i % 2 ? amp : -amp), ease: "linear" });
        // A real impact wobbles on its axis too (~±1°).
        rot.push({ tMs, v: c.transform.rotationDeg + (i % 2 ? -1 : 1) * 1.1 * decay, ease: "linear" });
      }
      kfs.push({ tMs: Math.round(o.delayMs + o.durationMs + 1), v: c.transform.x, ease: "linear" });
      rot.push({ tMs: Math.round(o.delayMs + o.durationMs + 1), v: c.transform.rotationDeg, ease: "linear" });
      return { keyframes: { "transform.x": kfs, "transform.rotationDeg": rot } };
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
          v: c.transform.y + Math.sin(u * cycles * Math.PI * 2) * o.intensity * 0.12,
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
