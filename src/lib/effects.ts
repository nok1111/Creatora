/**
 * Effect registry — frontend mirror of `src-tauri/src/render/effects.rs`.
 *
 * Each effect maps its canonical params to a CSS `filter:` fragment or an
 * SVG `feColorMatrix`, using the same numeric semantics the Rust side
 * encodes for ffmpeg. Adding an effect = add a def here AND a branch in
 * render/effects.rs; parity is enforced by real-render tests.
 *
 * Keyframes: `evalKeyframes` mirrors `render/keyframes.rs::eval_at`
 * (piecewise-linear, clamped at both ends).
 */

import type { Effect, Keyframe } from "@/lib/project-types";

export interface EffectDef {
  type: string;
  label: string;
  /** param name → {default, min, max, step} for the inspector UI */
  params: Record<string, { def: number; min: number; max: number; step: number }>;
  /** CSS filter fragment; null when the effect needs an SVG matrix instead. */
  toCss?: (params: Record<string, number>) => string;
  /** 4×5 matrix (row-major) for SVG feColorMatrix — used for temperature. */
  toMatrix?: (params: Record<string, number>) => number[];
}

const p = (params: Record<string, number>, k: string, def = 0) => params[k] ?? def;

export const EFFECTS: EffectDef[] = [
  {
    type: "brightness",
    label: "Brightness",
    params: { amount: { def: 0, min: -1, max: 1, step: 0.01 } },
    toCss: (ps) => `brightness(${(1 + p(ps, "amount")).toFixed(4)})`,
  },
  {
    type: "exposure",
    label: "Exposure",
    params: { stops: { def: 0, min: -4, max: 4, step: 0.1 } },
    toCss: (ps) => `brightness(${Math.pow(2, p(ps, "stops")).toFixed(4)})`,
  },
  {
    type: "contrast",
    label: "Contrast",
    params: { amount: { def: 0, min: -1, max: 1, step: 0.01 } },
    toCss: (ps) => `contrast(${(1 + p(ps, "amount")).toFixed(4)})`,
  },
  {
    type: "saturation",
    label: "Saturation",
    params: { amount: { def: -0, min: -1, max: 2, step: 0.01 } },
    toCss: (ps) => `saturate(${(1 + p(ps, "amount")).toFixed(4)})`,
  },
  {
    type: "temperature",
    label: "Temperature",
    params: { amount: { def: 0, min: -1, max: 1, step: 0.01 } },
    toMatrix: (ps) => {
      const t = Math.max(-1, Math.min(1, p(ps, "amount")));
      const r = 1 + 0.15 * t;
      const g = 1 - 0.05 * t;
      const b = 1 - 0.15 * t;
      return [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0];
    },
  },
  {
    type: "blur",
    label: "Blur",
    params: { radius: { def: 0, min: 0, max: 100, step: 0.5 } },
    toCss: (ps) => `blur(${p(ps, "radius").toFixed(2)}px)`,
  },
];

/**
 * Audio effect registry — frontend mirror of `src-tauri/src/render/audiofx.rs`.
 * Same canonical `Effect` model (params = f64 map); no CSS mapping — the
 * preview applies them via the WebAudio chain (audio-preview.ts) and the
 * render encodes them as ffmpeg audio filters.
 */
export const AUDIO_EFFECTS: EffectDef[] = [
  {
    type: "highpass",
    label: "High-pass",
    params: { freq: { def: 80, min: 10, max: 20000, step: 10 } },
  },
  {
    type: "lowpass",
    label: "Low-pass",
    params: { freq: { def: 12000, min: 100, max: 20000, step: 100 } },
  },
  {
    type: "eq",
    label: "3-band EQ",
    params: {
      low: { def: 0, min: -24, max: 24, step: 0.5 },
      mid: { def: 0, min: -24, max: 24, step: 0.5 },
      high: { def: 0, min: -24, max: 24, step: 0.5 },
    },
  },
  {
    type: "denoise",
    label: "Denoise",
    params: { strength: { def: 12, min: 1, max: 97, step: 1 } },
  },
  {
    type: "compressor",
    label: "Compressor",
    params: {
      thresholdDb: { def: -18, min: -60, max: 0, step: 1 },
      ratio: { def: 3, min: 1, max: 20, step: 0.5 },
      attackMs: { def: 20, min: 0.01, max: 2000, step: 1 },
      releaseMs: { def: 250, min: 0.01, max: 9000, step: 10 },
      makeupDb: { def: 0, min: -12, max: 24, step: 0.5 },
    },
  },
  {
    type: "limiter",
    label: "Limiter",
    params: {
      levelDb: { def: -0.45, min: -12, max: 0, step: 0.05 },
    },
  },
  {
    type: "deesser",
    label: "De-esser",
    params: { amount: { def: 0.5, min: 0, max: 1, step: 0.05 } },
  },
  {
    type: "noisegate",
    label: "Noise gate",
    params: {
      thresholdDb: { def: -50, min: -90, max: 0, step: 1 },
      attackMs: { def: 20, min: 0.02, max: 2000, step: 1 },
      releaseMs: { def: 250, min: 0.05, max: 4000, step: 10 },
    },
  },
];

export function effectDef(type: string): EffectDef | undefined {
  return EFFECTS.find((d) => d.type === type) ?? AUDIO_EFFECTS.find((d) => d.type === type);
}

/**
 * Combined CSS `filter:` string for an enabled stack, preserving order.
 * Matrix effects are emitted separately via `svgFilterFor`.
 */
/** Effects active at clip-relative `relMs` — an undefined window edge is
 *  unbounded, so legacy whole-clip effects always pass. Mirrors the
 *  `enable='between(t,…)'` the render emits. */
export function effectsActiveAt(effects: Effect[], relMs: number): Effect[] {
  return effects.filter(
    (e) =>
      e.enabled &&
      (e.inMs == null || relMs >= e.inMs) &&
      (e.outMs == null || relMs < e.outMs),
  );
}

export function cssFilterFor(effects: Effect[]): string {
  return effects
    .filter((e) => e.enabled)
    .map((e) => effectDef(e.type)?.toCss?.(e.params))
    .filter(Boolean)
    .join(" ");
}

/** First matrix-based effect in the stack (v1 renders one SVG matrix). */
export function svgMatrixFor(effects: Effect[]): number[] | null {
  for (const e of effects) {
    if (!e.enabled) continue;
    const m = effectDef(e.type)?.toMatrix?.(e.params);
    if (m) return m;
  }
  return null;
}

// ---------- keyframes ----------

/** Mirror of render/keyframes.rs::eval_at — linear, clamped. */
export function evalKeyframes(kfs: Keyframe[] | undefined, tMs: number, base: number): number {
  if (!kfs || kfs.length === 0) return base;
  const ks = [...kfs].sort((a, b) => a.tMs - b.tMs);
  if (tMs <= ks[0].tMs) return ks[0].v;
  if (tMs >= ks[ks.length - 1].tMs) return ks[ks.length - 1].v;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (tMs >= a.tMs && tMs <= b.tMs) {
      const span = b.tMs - a.tMs;
      if (span <= 0) return b.v;
      const u = (tMs - a.tMs) / span;
      return a.v + (b.v - a.v) * u;
    }
  }
  return base;
}

/** Animatable paths — must match render/keyframes.rs::ANIMATABLE. */
export const ANIMATABLE_PATHS = [
  "transform.x",
  "transform.y",
  "transform.scaleX",
  "transform.scaleY",
  "transform.rotationDeg",
  "transform.opacity",
  "volume",
] as const;

export type AnimatablePath = (typeof ANIMATABLE_PATHS)[number];
