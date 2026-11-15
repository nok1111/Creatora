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
  /** Raw SVG filter primitives (feConvolveMatrix, feTurbulence chains, …)
   *  for effects CSS can't express. */
  toSvg?: (params: Record<string, number>) => string;
  /** Non-filter preview style (vignette → inset box-shadow approx). */
  toBoxShadow?: (params: Record<string, number>) => string;
  /** Overlay layer composited above the media (scanlines → repeating
   *  gradient). Returns a CSS `background` value; Preview renders it in a
   *  sibling div over the same rect. */
  toOverlay?: (params: Record<string, number>) => string;
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
  {
    type: "grayscale",
    label: "Grayscale",
    params: { amount: { def: 1, min: 0, max: 1, step: 0.01 } },
    // CSS grayscale(a) === saturate(1-a) — same luminance matrix family.
    toCss: (ps) => `grayscale(${p(ps, "amount", 1).toFixed(4)})`,
  },
  {
    type: "sepia",
    label: "Sepia",
    params: { amount: { def: 1, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => `sepia(${p(ps, "amount", 1).toFixed(4)})`,
  },
  {
    type: "invert",
    label: "Invert",
    params: { amount: { def: 1, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => `invert(${p(ps, "amount", 1).toFixed(4)})`,
  },
  {
    type: "hueRotate",
    label: "Hue rotate",
    params: { deg: { def: 45, min: -180, max: 180, step: 1 } },
    toCss: (ps) => `hue-rotate(${p(ps, "deg", 45).toFixed(1)}deg)`,
  },
  {
    type: "sharpen",
    label: "Sharpen",
    params: { amount: { def: 1, min: 0, max: 3, step: 0.05 } },
    // Preview: unsharp-mask convolve kernel (ffmpeg render uses unsharp).
    toSvg: (ps) => {
      const a = p(ps, "amount", 1);
      const c = 1 + 4 * a;
      return `<feConvolveMatrix order="3" kernelMatrix="0 ${-a} 0 ${-a} ${c} ${-a} 0 ${-a} 0" preserveAlpha="true"/>`;
    },
  },
  {
    type: "vignette",
    label: "Vignette",
    params: { amount: { def: 0.5, min: 0, max: 1, step: 0.01 } },
    // Preview approximates the ffmpeg vignette with an inset shadow.
    toBoxShadow: (ps) => {
      const a = p(ps, "amount", 0.5);
      return `inset 0 0 ${(a * 120).toFixed(0)}px rgba(0,0,0,${(a * 0.85).toFixed(3)})`;
    },
  },
  {
    type: "grain",
    label: "Film grain",
    params: { amount: { def: 0.35, min: 0, max: 1, step: 0.01 } },
    // Preview: static turbulence clipped to the source, blended over it.
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.35);
      return [
        `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="fxNoise"/>`,
        `<feComponentTransfer in="fxNoise" result="fxNoiseA"><feFuncA type="linear" slope="${(a * 1.6).toFixed(3)}" intercept="0"/></feComponentTransfer>`,
        `<feComposite in="fxNoiseA" in2="SourceGraphic" operator="in" result="fxGrain"/>`,
        `<feBlend in="SourceGraphic" in2="fxGrain" mode="overlay"/>`,
      ].join("");
    },
  },
  {
    type: "channelSwap",
    label: "Channel swap",
    params: { amount: { def: 1, min: 0, max: 1, step: 0.01 } },
    // R↔B swap (aerochrome vibe). amount interpolates identity→swap.
    toMatrix: (ps) => {
      const a = p(ps, "amount", 1);
      const i = 1 - a;
      return [i, 0, a, 0, 0, 0, 1, 0, 0, 0, a, 0, i, 0, 0, 0, 0, 0, 1, 0];
    },
  },
  {
    type: "posterize",
    label: "Posterize",
    params: { levels: { def: 8, min: 2, max: 32, step: 1 } },
    // Quantize to N levels — exact same staircase as the lutrgb render.
    toSvg: (ps) => {
      const l = Math.max(2, Math.round(p(ps, "levels", 8)));
      const t = Array.from({ length: l }, (_, i) => (i / (l - 1)).toFixed(4)).join(" ");
      return `<feComponentTransfer><feFuncR type="discrete" tableValues="${t}"/><feFuncG type="discrete" tableValues="${t}"/><feFuncB type="discrete" tableValues="${t}"/></feComponentTransfer>`;
    },
  },
  {
    type: "scanlines",
    label: "Scanlines",
    params: { strength: { def: 0.4, min: 0, max: 1, step: 0.01 } },
    toOverlay: (ps) => {
      const a = p(ps, "strength", 0.4);
      return `repeating-linear-gradient(0deg, rgba(0,0,0,${a.toFixed(3)}) 0px, rgba(0,0,0,${a.toFixed(3)}) 1px, transparent 1px, transparent 3px)`;
    },
  },
  {
    type: "rgbShift",
    label: "RGB shift",
    params: { shift: { def: 6, min: 0, max: 40, step: 0.5 } },
    // Per-channel offsets — same geometry as ffmpeg rgbashift (smear edges
    // approximated by screen-blending the isolated channels back).
    toSvg: (ps) => {
      const s = p(ps, "shift", 6);
      const iso = (vals: string, res: string) =>
        `<feColorMatrix in="SourceGraphic" type="matrix" values="${vals}" result="${res}"/>`;
      return [
        iso("1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0", "fxR"),
        `<feOffset in="fxR" dx="${s}" dy="0" result="fxRo"/>`,
        iso("0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0", "fxG"),
        iso("0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0", "fxB"),
        `<feOffset in="fxB" dx="${-s}" dy="0" result="fxBo"/>`,
        `<feBlend in="fxRo" in2="fxG" mode="screen" result="fxRG"/>`,
        `<feBlend in="fxRG" in2="fxBo" mode="screen"/>`,
      ].join("");
    },
  },
  {
    type: "edges",
    label: "Neon edges",
    params: { amount: { def: 0.5, min: 0, max: 1, step: 0.01 } },
    // Laplacian edge kernel ≈ ffmpeg edgedetect=colormix.
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.5);
      const k = 1 + 3 * a; // edge gain with amount
      return `<feConvolveMatrix order="3" kernelMatrix="0 ${(-k).toFixed(2)} 0 ${(-k).toFixed(2)} ${(4 * k).toFixed(2)} ${(-k).toFixed(2)} 0 ${(-k).toFixed(2)} 0" preserveAlpha="true"/>`;
    },
  },
  {
    type: "filmNoir",
    label: "Film noir",
    params: { amount: { def: 1, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => `grayscale(${p(ps, "amount", 1).toFixed(3)}) contrast(1.35)`,
    toBoxShadow: () => "inset 0 0 60px rgba(0,0,0,0.5)",
  },
  {
    type: "dreamGlow",
    label: "Dream glow",
    params: { amount: { def: 0.5, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => {
      const a = p(ps, "amount", 0.5);
      return `blur(${(a * 5).toFixed(2)}px) brightness(${(1 + 0.24 * a).toFixed(3)}) saturate(${(1 + 0.2 * a).toFixed(3)})`;
    },
  },
  {
    type: "blockbuster",
    label: "Blockbuster",
    params: { amount: { def: 1, min: 0, max: 1, step: 0.01 } },
    // Teal shadows / orange highlights grade — single channel mix.
    toMatrix: (ps) => {
      const a = p(ps, "amount", 1);
      const l = (from: number, to: number) => from + (to - from) * a;
      return [
        l(1, 1.15), 0, l(0, -0.08), 0, 0,
        l(0, -0.02), 1, 0, 0, 0,
        l(0, 0.08), l(0, 0.02), l(1, 0.92), 0, 0,
        0, 0, 0, 1, 0,
      ];
    },
  },
  {
    type: "matteFade",
    label: "Matte fade",
    params: { amount: { def: 0.7, min: 0, max: 1, step: 0.01 } },
    // Lifted blacks + gentle desat — the trendy washed look.
    toCss: (ps) => {
      const a = p(ps, "amount", 0.7);
      return `contrast(${(1 - 0.15 * a).toFixed(3)}) brightness(${(1 + 0.12 * a).toFixed(3)}) saturate(${(1 - 0.2 * a).toFixed(3)})`;
    },
  },
  {
    type: "popColor",
    label: "Pop color",
    params: { amount: { def: 0.5, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => {
      const a = p(ps, "amount", 0.5);
      return `saturate(${(1 + 1.1 * a).toFixed(3)}) contrast(${(1 + 0.24 * a).toFixed(3)})`;
    },
  },
  {
    type: "retro",
    label: "Retro film",
    params: { amount: { def: 0.8, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => {
      const a = p(ps, "amount", 0.8);
      return `sepia(${(0.35 * a).toFixed(3)}) saturate(${(1 - 0.25 * a).toFixed(3)}) brightness(1.05) contrast(0.95)`;
    },
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.8) * 0.35;
      return [
        `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="fxNoise"/>`,
        `<feComponentTransfer in="fxNoise" result="fxNoiseA"><feFuncA type="linear" slope="${(a * 1.6).toFixed(3)}" intercept="0"/></feComponentTransfer>`,
        `<feComposite in="fxNoiseA" in2="SourceGraphic" operator="in" result="fxGrain"/>`,
        `<feBlend in="SourceGraphic" in2="fxGrain" mode="overlay"/>`,
      ].join("");
    },
  },
  {
    type: "crt",
    label: "CRT monitor",
    params: { amount: { def: 0.6, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => `saturate(${(1 - 0.25 * p(ps, "amount", 0.6)).toFixed(3)})`,
    toSvg: (ps) => {
      const s = 2.5 * p(ps, "amount", 0.6);
      const iso = (vals: string, res: string) =>
        `<feColorMatrix in="SourceGraphic" type="matrix" values="${vals}" result="${res}"/>`;
      return [
        iso("1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0", "fxR"),
        `<feOffset in="fxR" dx="${s.toFixed(2)}" dy="0" result="fxRo"/>`,
        iso("0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0", "fxG"),
        iso("0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0", "fxB"),
        `<feOffset in="fxB" dx="${(-s).toFixed(2)}" dy="0" result="fxBo"/>`,
        `<feBlend in="fxRo" in2="fxG" mode="screen" result="fxRG"/>`,
        `<feBlend in="fxRG" in2="fxBo" mode="screen"/>`,
      ].join("");
    },
    toOverlay: (ps) => {
      const a = 0.5 * p(ps, "amount", 0.6);
      return `repeating-linear-gradient(0deg, rgba(0,0,0,${a.toFixed(3)}) 0px, rgba(0,0,0,${a.toFixed(3)}) 1px, transparent 1px, transparent 3px)`;
    },
    toBoxShadow: () => "inset 0 0 80px rgba(0,0,0,0.45)",
  },
  {
    type: "vhs",
    label: "VHS tape",
    params: { amount: { def: 0.7, min: 0, max: 1, step: 0.01 } },
    toCss: (ps) => {
      const a = p(ps, "amount", 0.7);
      return `sepia(${(0.3 * a).toFixed(3)}) saturate(${(1 - 0.35 * a).toFixed(3)}) brightness(1.06) contrast(0.92)`;
    },
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.7);
      const s = 4 * a;
      const iso = (vals: string, res: string) =>
        `<feColorMatrix in="SourceGraphic" type="matrix" values="${vals}" result="${res}"/>`;
      return [
        iso("1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0", "fxR"),
        `<feOffset in="fxR" dx="${s.toFixed(2)}" dy="0" result="fxRo"/>`,
        iso("0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0", "fxG"),
        iso("0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0", "fxB"),
        `<feOffset in="fxB" dx="${(-s).toFixed(2)}" dy="0" result="fxBo"/>`,
        `<feBlend in="fxRo" in2="fxG" mode="screen" result="fxRG"/>`,
        `<feBlend in="fxRG" in2="fxBo" mode="screen" result="fxBase"/>`,
        `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="fxNoise"/>`,
        `<feComponentTransfer in="fxNoise" result="fxNoiseA"><feFuncA type="linear" slope="${(a * 0.8).toFixed(3)}" intercept="0"/></feComponentTransfer>`,
        `<feComposite in="fxNoiseA" in2="fxBase" operator="in" result="fxGrain"/>`,
        `<feBlend in="fxBase" in2="fxGrain" mode="overlay"/>`,
      ].join("");
    },
    toOverlay: (ps) => {
      const a = 0.4 * p(ps, "amount", 0.7);
      return `repeating-linear-gradient(0deg, rgba(0,0,0,${a.toFixed(3)}) 0px, rgba(0,0,0,${a.toFixed(3)}) 1px, transparent 1px, transparent 3px)`;
    },
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

/** Params applied when an overlay effect is dropped on the timeline —
 *  signature-strength so each effect lands showing its own look (a
 *  uniform 0.25 makes sepia indistinguishable from temperature). The
 *  inspector dials it back from here. */
export const EFFECT_DROP_PARAMS: Record<string, Record<string, number>> = {
  brightness: { amount: 0.25 },
  contrast: { amount: 0.35 },
  saturation: { amount: 0.4 },
  blur: { radius: 8 },
  grayscale: { amount: 1 },
  sepia: { amount: 0.85 },
  invert: { amount: 1 },
  hueRotate: { deg: 120 },
  sharpen: { amount: 1.5 },
  vignette: { amount: 0.6 },
  grain: { amount: 0.45 },
  channelSwap: { amount: 1 },
  posterize: { levels: 6 },
  scanlines: { strength: 0.45 },
  rgbShift: { shift: 8 },
  edges: { amount: 0.6 },
  filmNoir: { amount: 1 },
  dreamGlow: { amount: 0.6 },
  blockbuster: { amount: 1 },
  matteFade: { amount: 0.75 },
  popColor: { amount: 0.6 },
  retro: { amount: 0.85 },
  crt: { amount: 0.65 },
  vhs: { amount: 0.8 },
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
export function svgFilterFragmentFor(effects: Effect[]): string | null {
  const parts: string[] = [];
  for (const e of effects) {
    if (!e.enabled) continue;
    const def = effectDef(e.type);
    const m = def?.toMatrix?.(e.params);
    if (m) parts.push(`<feColorMatrix type="matrix" values="${m.join(" ")}"/>`);
    const s = def?.toSvg?.(e.params);
    if (s) parts.push(s);
  }
  return parts.length ? parts.join("") : null;
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
 *  same order as the effect stack. */
export function overlayFor(effects: Effect[]): string | undefined {
  const layers = effects
    .filter((e) => e.enabled)
    .map((e) => effectDef(e.type)?.toOverlay?.(e.params))
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
