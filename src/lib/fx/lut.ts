/**
 * Filter LUT baker — evaluates a `kind:"filter"` entry's `lut` ops on a
 * 33³ RGB grid. The SAME spec is baked here (→ WebGL2 3D texture / .cube
 * text) and by Rust `render/fxlut.rs` (→ .cube file for `lut3d`), so the
 * preview and the export share one color transform bit-for-bit.
 *
 * Every op is a pure function on display-referred RGB (0..1) and all ops
 * run in a fixed order — the formulas below are the canonical spec, the
 * Rust side mirrors them literally (sparse-golden test pins both within
 * 1e-4; libm may differ by 1 ulp between runtimes).
 *
 * Grid order matches the .cube convention AND the GL texture layout:
 * blue-major, green-middle, red-fastest → idx = b*33*33 + g*33 + r.
 *
 * Intensity is baked in: lut = mix(identity, spec, intensity/100). Because
 * trilinear sampling is linear, sampling the pre-mixed LUT equals
 * mix(c, lut_spec(c), i) — the exact math the GL shader applies when the
 * intensity changes live (shader mixes at sample time; the export bakes
 * the current value).
 */

import { resolveConstants, type FxEntry, fmtNum } from "./manifest";
import type { LutOp, Num } from "../../../shared/fx/build.ts";

export const LUT_SIZE = 33;
export const LUT_NODES = LUT_SIZE * LUT_SIZE * LUT_SIZE;

type V3 = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const LUMA: V3 = [0.2126, 0.7152, 0.0722];
const luma = (c: V3) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

// ── hsl helpers ────────────────────────────────────────────────────────

export function rgb2hsl(c: V3): V3 {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

export function hsl2rgb([h, s, l]: V3): V3 {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// ── curves: monotone cubic (Fritsch–Carlson PCHIP) ─────────────────────

function pchip(pts: [number, number][]): (x: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (n === 1) return () => ys[0];
  const d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++)
    m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = Math.hypot(a, b);
      if (h > 3) {
        m[i] = (3 * a) / h * d[i];
        m[i + 1] = (3 * b) / h * d[i];
      }
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const dx = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / dx;
    const t2 = t * t, t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * dx * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * dx * m[i + 1]
    );
  };
}

// ── op evaluators ──────────────────────────────────────────────────────

const num = (v: Num, consts: Record<string, number>): number =>
  typeof v === "number" ? v : consts[v.slice(1, -1)] ?? 0;

const vec = (v: [Num, Num, Num], consts: Record<string, number>): V3 => [
  num(v[0], consts),
  num(v[1], consts),
  num(v[2], consts),
];

function applyOp(c: V3, op: LutOp, k: Record<string, number>): V3 {
  switch (op.op) {
    case "temp": {
      const a = num(op.amt, k);
      return [clamp01(c[0] * (1 + 0.3 * a)), clamp01(c[1] * (1 + 0.06 * a)), clamp01(c[2] * (1 - 0.3 * a))];
    }
    case "tint": {
      const a = num(op.amt, k);
      return [clamp01(c[0] * (1 + 0.12 * a)), clamp01(c[1] * (1 - 0.22 * a)), clamp01(c[2] * (1 + 0.12 * a))];
    }
    case "sat": {
      const a = num(op.amt, k), l = luma(c);
      return [0, 1, 2].map((i) => clamp01(l + (c[i] - l) * a)) as V3;
    }
    case "vib": {
      const a = num(op.amt, k);
      const mx = Math.max(...c), mn = Math.min(...c);
      const s = mx > 0 ? (mx - mn) / mx : 0;
      const l = luma(c), f = 1 + a * (1 - s);
      return [0, 1, 2].map((i) => clamp01(l + (c[i] - l) * f)) as V3;
    }
    case "lgg": {
      const lift = vec(op.lift, k), gamma = vec(op.gamma, k), gain = vec(op.gain, k);
      return [0, 1, 2].map((i) => {
        const x = clamp01(c[i] * (gain[i] - lift[i]) + lift[i]);
        return clamp01(Math.pow(x, 1 / Math.max(0.05, gamma[i])));
      }) as V3;
    }
    case "curve": {
      const f = pchip(op.pts);
      const ch = Math.round(num(op.ch, k));
      if (ch >= 3) {
        const l = luma(c);
        const nl = clamp01(f(clamp01(l)));
        const d = nl - l;
        return [clamp01(c[0] + d), clamp01(c[1] + d), clamp01(c[2] + d)];
      }
      const out = [...c] as V3;
      out[ch] = clamp01(f(clamp01(c[ch])));
      return out;
    }
    case "split": {
      const l = luma(c);
      const [shH, shS] = [num(op.sh[0], k), num(op.sh[1], k)];
      const [hiH, hiS] = [num(op.hi[0], k), num(op.hi[1], k)];
      const shT = hsl2rgb([((shH % 360) + 360) % 360 / 360, Math.min(1, shS * 2), l]);
      const hiT = hsl2rgb([((hiH % 360) + 360) % 360 / 360, Math.min(1, hiS * 2), l]);
      const wS = (1 - l) * Math.min(1, shS);
      const wH = l * Math.min(1, hiS);
      return [0, 1, 2].map((i) =>
        clamp01(c[i] * (1 - wS - wH) + shT[i] * wS + hiT[i] * wH),
      ) as V3;
    }
    case "mixer": {
      const m = op.m;
      return [0, 1, 2].map((i) =>
        clamp01(c[0] * m[i][0] + c[1] * m[i][1] + c[2] * m[i][2]),
      ) as V3;
    }
    case "hsl": {
      const [hue0, range, dh, ds, dl] = [num(op.hue, k), num(op.range, k), num(op.dh, k), num(op.ds, k), num(op.dl, k)];
      const hsl = rgb2hsl(c);
      let dhue = Math.abs(hsl[0] * 360 - hue0);
      dhue = Math.min(dhue, 360 - dhue);
      const w = Math.exp(-((dhue / Math.max(1e-3, range)) ** 2));
      const h = (((hsl[0] + (dh * w) / 360) % 1) + 1) % 1;
      const s = clamp01(hsl[1] * (1 + (ds - 1) * w));
      const l = clamp01(hsl[2] + dl * w);
      return hsl2rgb([h, s, l]);
    }
    case "fade": {
      const a = num(op.amt, k);
      return [0, 1, 2].map((i) => clamp01(c[i] * (1 - a) + a * (0.14 + 0.75 * c[i]))) as V3;
    }
    case "levels": {
      const [iB, iW, oB, oW, g] = [num(op.inB, k), num(op.inW, k), num(op.outB, k), num(op.outW, k), num(op.gamma, k)];
      const span = Math.max(1e-3, iW - iB);
      return [0, 1, 2].map((i) => {
        const x = Math.pow(clamp01((c[i] - iB) / span), 1 / Math.max(0.05, g));
        return clamp01(oB + x * (oW - oB));
      }) as V3;
    }
  }
}

/** Apply the whole op list to one color (identity-safe). */
export function applyLut(c: V3, ops: LutOp[], consts: Record<string, number>): V3 {
  for (const op of ops) c = applyOp(c, op, consts);
  return c;
}

/**
 * Bake the grid: `[r,g,b,…]` per node, blue-major / red-fastest.
 * `rgba` adds an alpha=1 lane (for RGBA32F texImage3D).
 */
export function bakeLutData(
  ops: LutOp[] | undefined,
  consts: Record<string, number>,
  intensity: number,
  rgba = false,
): Float32Array {
  const S = LUT_SIZE, lane = rgba ? 4 : 3;
  const out = new Float32Array(LUT_NODES * lane);
  const mix = Math.min(1, Math.max(0, intensity));
  let i = 0;
  for (let b = 0; b < S; b++)
    for (let g = 0; g < S; g++)
      for (let r = 0; r < S; r++) {
        const c: V3 = [r / (S - 1), g / (S - 1), b / (S - 1)];
        const t = ops?.length ? applyLut(c, ops, consts) : c;
        out[i] = c[0] + (t[0] - c[0]) * mix;
        out[i + 1] = c[1] + (t[1] - c[1]) * mix;
        out[i + 2] = c[2] + (t[2] - c[2]) * mix;
        if (rgba) out[i + 3] = 1;
        i += lane;
      }
  return out;
}

/** The .cube text the Rust side must reproduce byte-similarly (6 decimals). */
export function bakeCubeText(
  entry: FxEntry,
  params?: Record<string, number>,
): string {
  const consts = resolveConstants(entry, params);
  const intensity = (consts.intensity ?? 100) / 100;
  const data = bakeLutData(entry.lut, consts, intensity);
  const lines = [`LUT_3D_SIZE ${LUT_SIZE}`, `# ${entry.id}`];
  for (let i = 0; i < LUT_NODES; i++)
    lines.push(`${fmtNum(data[i * 3])} ${fmtNum(data[i * 3 + 1])} ${fmtNum(data[i * 3 + 2])}`);
  return lines.join("\n") + "\n";
}

/** Constants for a filter entry (validated params + derived). */
export function filterConsts(entry: FxEntry, params?: Record<string, number>) {
  return resolveConstants(entry, params);
}
