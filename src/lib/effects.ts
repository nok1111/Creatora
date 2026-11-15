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
  /** Effect is render-only (LUT import): preview can't express it cheaply,
   *  so the strip shows but the preview is untouched. Documented, not a bug. */
  noPreview?: boolean;
}

const p = (params: Record<string, number>, k: string, def = 0) => params[k] ?? def;

/** W3C saturate() as a 4×5 feColorMatrix (row-major, offsets in 0..1). */
const satMat = (s: number): number[] => [
  0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
  0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
  0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
  0, 0, 0, 1, 0,
];
const mixerMat = (
  rr: number, rg: number, rb: number,
  gr: number, gg: number, gb: number,
  br: number, bg: number, bb: number,
): number[] => [rr, rg, rb, 0, 0, gr, gg, gb, 0, 0, br, bg, bb, 0, 0, 0, 0, 0, 1, 0];
/** CSS contrast(c) as an affine matrix — out = c·in + (0.5−0.5c). */
const contrastMat = (c: number): number[] => {
  const k = 0.5 - 0.5 * c;
  return [c, 0, 0, 0, k, 0, c, 0, 0, k, 0, 0, c, 0, k, 0, 0, 0, 1, 0];
};
const matSvg = (m: number[]) =>
  `<feColorMatrix type="matrix" values="${m.map((v) => +v.toFixed(4)).join(" ")}"/>`;

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
    type: "flashWhite",
    label: "Flash (white)",
    params: { peak: { def: 0.85, min: 0.05, max: 1, step: 0.01 } },
    // out = in·(1−p) + 255·p — preview overlays flat white at alpha p.
    toOverlay: (ps) => `rgba(255,255,255,${p(ps, "peak", 0.85).toFixed(3)})`,
  },
  {
    type: "flashBlack",
    label: "Flash (black)",
    params: { peak: { def: 0.85, min: 0.05, max: 1, step: 0.01 } },
    toOverlay: (ps) => `rgba(0,0,0,${p(ps, "peak", 0.85).toFixed(3)})`,
  },
  {
    type: "letterbox",
    label: "Cinematic bars",
    params: { bars: { def: 0.115, min: 0.02, max: 0.3, step: 0.005 } },
    toOverlay: (ps) => {
      const b = (p(ps, "bars", 0.115) * 100).toFixed(1);
      return `linear-gradient(0deg, #000 0%, #000 ${b}%, transparent ${b}%, transparent ${100 - Number(b)}%, #000 ${100 - Number(b)}%, #000 100%)`;
    },
  },
  {
    type: "vibrance",
    label: "Vibrance",
    params: { amount: { def: 0.5, min: 0, max: 1, step: 0.01 } },
    // ffmpeg vibrance saturates only low-sat pixels (protects skin); CSS
    // has no equivalent — preview shows a gentle global saturate as a hint.
    toCss: (ps) => `saturate(${(1 + 0.5 * p(ps, "amount", 0.5)).toFixed(4)})`,
  },
  {
    type: "colorBalance",
    label: "Color balance",
    // Warmth per tonal range: + = warm (red-yellow), − = cool (blue).
    params: {
      shadows: { def: 0, min: -1, max: 1, step: 0.05 },
      midtones: { def: 0, min: -1, max: 1, step: 0.05 },
      highlights: { def: 0, min: -1, max: 1, step: 0.05 },
    },
    // Luma-masked additive tints — same math as ffmpeg colorbalance
    // (shift added only where the tonal mask applies).
    toSvg: (ps) => {
      const ranges: [string, string, number][] = [
        ["S", "1 0.34 0 0", p(ps, "shadows")],
        ["M", "0 1 0", p(ps, "midtones")],
        ["H", "0 0 0.34 1", p(ps, "highlights")],
      ];
      const frags: string[] = [
        `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.213 0.715 0.072 0 0" result="fxLuma"/>`,
      ];
      let prev = "SourceGraphic";
      let i = 0;
      for (const [name, table, w] of ranges) {
        if (Math.abs(w) < 0.01) continue;
        const color = w > 0 ? "rgb(255,90,0)" : "rgb(0,80,255)";
        const op = Math.min(1, Math.abs(w) * 0.6).toFixed(3);
        frags.push(
          `<feComponentTransfer in="fxLuma" result="fxMask${name}"><feFuncA type="table" tableValues="${table}"/></feComponentTransfer>`,
          `<feFlood flood-color="${color}" flood-opacity="${op}" result="fxTint${name}"/>`,
          `<feComposite in="fxTint${name}" in2="fxMask${name}" operator="in" result="fxLayer${name}"/>`,
          `<feComposite in="${prev}" in2="fxLayer${name}" operator="arithmetic" k2="1" k3="1" result="fxCB${i}"/>`,
        );
        prev = `fxCB${i++}`;
      }
      return frags.length > 1 ? frags.join("") : "";
    },
  },
  {
    type: "bleachBypass",
    label: "Bleach bypass",
    params: { amount: { def: 0.8, min: 0, max: 1, step: 0.01 } },
    // Desaturate hard + lift contrast — the "Saving Private Ryan" grade.
    // Preview mirrors the render chain exactly: sat matrix then affine
    // contrast, as two feColorMatrix primitives.
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.8);
      return [matSvg(satMat(1 - 0.65 * a)), matSvg(contrastMat(1 + 0.8 * a))].join("");
    },
  },
  {
    type: "goldenHour",
    label: "Golden hour",
    params: { amount: { def: 0.7, min: 0, max: 1, step: 0.01 } },
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.7);
      return [
        matSvg(mixerMat(1 + 0.14 * a, 0.03 * a, 0, 0.02 * a, 1 + 0.04 * a, 0, 0, 0, 1 - 0.22 * a)),
        matSvg(satMat(1 + 0.1 * a)),
      ].join("");
    },
  },
  {
    type: "dayForNight",
    label: "Day for night",
    params: { amount: { def: 0.7, min: 0, max: 1, step: 0.01 } },
    toSvg: (ps) => {
      const a = p(ps, "amount", 0.7);
      const dim = 1 - 0.18 * a;
      return [
        matSvg(mixerMat(0.5 * dim, 0.08 * a, 0.12 * a, 0.06 * a, 0.62 * dim, 0.1 * a, 0.1 * a, 0.14 * a, 0.9 * dim)),
        matSvg(satMat(1 - 0.45 * a)),
      ].join("");
    },
  },
  {
    type: "lut",
    label: "Import LUT",
    params: {},
    // Render-only: .cube 3D LUTs can't be expressed as CSS/SVG filters.
    // The file path lives on Effect.file; the inspector exposes a picker.
    noPreview: true,
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
  sharpen: { amount: 1.5 },
  vignette: { amount: 0.6 },
  grain: { amount: 0.45 },
  flashWhite: { peak: 0.85 },
  flashBlack: { peak: 0.85 },
  letterbox: { bars: 0.115 },
  vibrance: { amount: 0.5 },
  colorBalance: { shadows: -0.2, midtones: 0.3, highlights: 0.2 },
  bleachBypass: { amount: 0.8 },
  goldenHour: { amount: 0.7 },
  dayForNight: { amount: 0.7 },
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
