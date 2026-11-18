/**
 * Closed-form curves of the library effects. These are mirrored 1:1 by
 * `src-tauri/src/render/fxeffects.rs` — `shared/fx/curves.golden.json` pins
 * both implementations to the same numbers, and Rust render tests measure
 * the ffmpeg output against them, so the preview shows what the export does.
 */

export const roundHalfUp = (x: number) => Math.floor(x + 0.5);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 2^(-10u) normalised so g(0)=1 and g(1)=0 exactly. */
export function expoDecay(u: number): number {
  const K = 2 ** -10;
  return Math.max(0, (2 ** (-10 * clamp01(u)) - K) / (1 - K));
}

/** RGB-displacement envelope 0..1. mode: 0 static, 1 pulse, 2 glitch. */
export function rgbEnv(mode: number, speed: number, t: number): number {
  if (mode === 0) return 1;
  if (mode === 1) return Math.abs(Math.cos(Math.PI * speed * t)) ** 3;
  const slot = Math.floor(t * speed * 2);
  const h = (((slot * 0.6180339887498949) % 1) + 1) % 1;
  return h < 0.55 ? 0.15 : 0.15 + 0.85 * ((h - 0.55) / 0.45);
}

/** Integer (rh, rv) red shift in px; blue gets the negation. */
export function rgbShift(amountPct: number, angleDeg: number, env: number, width: number): [number, number] {
  const px = (amountPct / 100) * width * env;
  const a = (angleDeg * Math.PI) / 180;
  return [roundHalfUp(px * Math.cos(a)), roundHalfUp(px * Math.sin(a))];
}

/** Hero Entrance: zoom multiplier (≥1) at clip-relative `t` seconds. */
export const heroScale = (zoom: number, durS: number, t: number) =>
  1 + zoom * expoDecay(t / durS);

/** Hero Entrance: exposure flash in `eq` brightness units (RGB offset =
 *  value·255/219 — `eq` works on limited-range luma). */
export const heroFlash = (flash: number, durS: number, t: number) =>
  0.6 * flash * Math.max(0, 1 - Math.min(t / durS, 1) / 0.35) ** 2;

/** Hero Entrance: horizontal RGB split in px. */
export const heroSplitPx = (splitPct: number, width: number, durS: number, t: number) =>
  roundHalfUp((splitPct / 100) * width * expoDecay(t / durS));

/** eq brightness → equal RGB offset as a 0..1 fraction. */
export const eqToRgb = (b: number) => (b * 255) / 219;

/** Beat times (clip-relative seconds): source-time detections mapped
 *  through trim/speed, shifted by the sync offset, thinned by `every`. */
export function beatTimes(
  times: number[] | null | undefined,
  every: number,
  offsetMs: number,
  ctx: { sourceInMs: number; speed: number; clipMs: number },
): number[] {
  const v = (times ?? [])
    .map((src) => ((src - ctx.sourceInMs) / Math.max(0.01, ctx.speed) + offsetMs) / 1000)
    .filter((t) => t >= -0.5 && t <= ctx.clipMs / 1000)
    .sort((a, b) => a - b);
  return v.filter((_, i) => i % Math.max(1, every) === 0);
}

/** exp(-k·(t-b)) for the latest beat b ≤ t, else 0. `beats` sorted. */
export function beatEnv(beats: number[], k: number, t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) (at = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return at < 0 ? 0 : Math.exp(-k * (t - beats[at]));
}

export const BEAT_EVERY = [1, 2, 4];

// ── Light & atmosphere curves ─────────────────────────────────────────
// Mirrored 1:1 by fxeffects.rs; pinned in curves.golden.json.
// t = clip-relative seconds. Offsets are fractions of frame width/height.

/** Two-sine flicker in [1−2a, 1] (a ≤ 0.6) — additive light breathing. */
export function flickerEnv(amt: number, speed: number, t: number): number {
  const w =
    0.65 * Math.sin(6.2832 * speed * t) + 0.35 * Math.sin(6.2832 * speed * 2.63 * t + 1.3);
  return Math.max(0, 1 - amt + amt * w);
}

/** Lens-flare drift around the anchor, frame fractions [dx·W, dy·H]. */
export function flareDrift(speed: number, t: number): [number, number] {
  return [
    0.022 * Math.sin(6.2832 * speed * t + 0.7),
    0.012 * Math.sin(6.2832 * speed * 0.83 * t + 2.1),
  ];
}

/** Light-leak drift, frame fractions. The blob slides in and eases back;
 *  `travel` is the max excursion (fraction of width). Pattern picks the
 *  direction of the sweep. */
export function leakDrift(
  pattern: number,
  travel: number,
  speed: number,
  t: number,
): [number, number] {
  const s = 0.5 + 0.5 * Math.sin(6.2832 * speed * t - 1.5708);
  switch (pattern) {
    case 1:
      return [-0.5 * travel * s, 0.7 * travel * s]; // corner bloom: diagonal
    case 2:
      return [0.6 * travel * s, 0]; // dual sides: lateral slide
    default:
      return [travel * s, 0]; // edge sweep: slide in from the left
  }
}

/** God-rays sway (radians) about the baked fan orientation. */
export const raysSwayRad = (deg: number, speed: number, t: number) =>
  (deg * Math.PI) / 180 * Math.sin(6.2832 * speed * t);

/** Prism glint sweep — x offset in frame fractions, −0.35 → 1.35 loop. */
export function glintSweep(speed: number, t: number): number {
  if (speed <= 0) return 0;
  const u = speed * t - Math.floor(speed * t);
  return -0.35 + 1.7 * u;
}
