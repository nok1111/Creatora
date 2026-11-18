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
import { libraryEffectDefs } from "@/lib/fx/effects-impl";

/** Per-clip timing/geometry the library effects' preview curves need. */
export interface FxCtx {
  /** Clip-relative playhead (ms). */
  relMs: number;
  fps: number;
  /** Project canvas width (px) — shifts are defined against it. */
  canvasW: number;
  /** Rendered layer size in project px (for bbox-relative SVG offsets). */
  layerW: number;
  layerH: number;
  clipMs: number;
  sourceInMs: number;
  speed: number;
}

export interface EffectDef {
  type: string;
  label: string;
  /** param name → {default, min, max, step} for the inspector UI */
  params: Record<string, { def: number; min: number; max: number; step: number }>;
  /** Manifest id when the effect comes from the shared library. */
  fxId?: string;
  /** Multiplicative clip scale the effect adds (zoom punches). Library
   *  effects only — mirrors the render's zoompan. */
  toScale?: (params: Record<string, number>, ctx: FxCtx, fx: Effect) => number;
  /** CSS filter fragment; null when the effect needs an SVG matrix instead. */
  toCss?: (params: Record<string, number>) => string;
  /** 4×5 matrix (row-major) for SVG feColorMatrix — used for temperature. */
  toMatrix?: (params: Record<string, number>) => number[];
  /** Raw SVG filter primitives (feConvolveMatrix, feTurbulence chains, …)
   *  for effects CSS can't express. */
  toSvg?: (params: Record<string, number>, ctx?: FxCtx, fx?: Effect) => string;
  /** Non-filter preview style (vignette → inset box-shadow approx). */
  toBoxShadow?: (params: Record<string, number>) => string;
  /** Overlay layer composited above the media (scanlines → repeating
   *  gradient). Returns a CSS `background` value; Preview renders it in a
   *  sibling div over the same rect. `relMs` is the clip-relative playhead
   *  time — periodic effects (strobe) evaluate their phase from it, same
   *  as the render's per-frame `enable` expression. */
  toOverlay?: (params: Record<string, number>, relMs?: number) => string;
  /** Effect is render-only (LUT import): preview can't express it cheaply,
   *  so the strip shows but the preview is untouched. Documented, not a bug. */
  noPreview?: boolean;
  /** Preview runs in the shared WebGL2 filter compositor (Light &
   *  Atmosphere kind:"effect" entries with preview:"gl") — the DOM/SVG
   *  path intentionally produces nothing for these. */
  glPreview?: boolean;
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
    type: "blur",
    label: "Blur",
    params: { radius: { def: 0, min: 0, max: 100, step: 0.5 } },
    toCss: (ps) => `blur(${p(ps, "radius").toFixed(2)}px)`,
  },
  ...libraryEffectDefs(),
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

/** Params applied when an overlay effect is dropped on the timeline —
 *  signature-strength so each effect lands showing its own look (a
 *  uniform 0.25 makes sepia indistinguishable from temperature). The
 *  inspector dials it back from here. */
export const EFFECT_DROP_PARAMS: Record<string, Record<string, number>> = {
  brightness: { amount: 0.25 },
  contrast: { amount: 0.35 },
  saturation: { amount: 0.4 },
  blur: { radius: 8 },
};

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

/** Inner `<filter>` markup for all SVG-land effects in the stack:
 *  feColorMatrix fragments (toMatrix) followed by raw primitives (toSvg),
 *  preserving effect order. Null when nothing needs SVG. */
export function svgFilterFragmentFor(effects: Effect[], ctx?: FxCtx): string | null {
  // Each effect contributes one fragment; fragment k>0 must read the output
  // of fragment k-1, not the original source, or stacked effects overwrite
  // each other. An identity feOffset names each fragment's output.
  const frags: string[] = [];
  for (const e of effects) {
    if (!e.enabled) continue;
    const def = effectDef(e.type);
    let f = "";
    const m = def?.toMatrix?.(e.params);
    if (m) f += `<feColorMatrix type="matrix" values="${m.join(" ")}"/>`;
    const s = def?.toSvg?.(e.params, ctx, e);
    if (s) f += s;
    if (f) frags.push(f);
  }
  if (!frags.length) return null;
  return frags
    .map((f, i) => {
      const body = i > 0 ? f.replace(/in="SourceGraphic"/g, `in="fxStage${i - 1}"`) : f;
      return i < frags.length - 1
        ? `${body}<feOffset dx="0" dy="0" result="fxStage${i}"/>`
        : body;
    })
    .join("");
}

/** Product of the library effects' zoom multipliers at `ctx.relMs`. */
export function fxScaleFor(effects: Effect[], ctx: FxCtx): number {
  let k = 1;
  for (const e of effects) {
    if (!e.enabled) continue;
    const f = effectDef(e.type)?.toScale?.(e.params, ctx, e);
    if (f) k *= f;
  }
  return k;
}

/** Combined box-shadow layers (vignette etc.) for enabled effects. */
export function boxShadowFor(effects: Effect[]): string | undefined {
  const layers = effects
    .filter((e) => e.enabled)
    .map((e) => effectDef(e.type)?.toBoxShadow?.(e.params))
    .filter(Boolean);
  return layers.length ? layers.join(", ") : undefined;
}

/** Combined overlay backgrounds (scanlines etc.) — layered topmost-last,
 *  same order as the effect stack. `relMs` (clip-relative playhead, 0 when
 *  omitted) feeds periodic overlays like strobe. */
export function overlayFor(effects: Effect[], relMs = 0): string | undefined {
  const layers = effects
    .filter((e) => e.enabled)
    .map((e) => effectDef(e.type)?.toOverlay?.(e.params, relMs))
    .filter(Boolean);
  return layers.length ? layers.join(", ") : undefined;
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
