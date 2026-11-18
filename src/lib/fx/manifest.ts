/**
 * FX manifest — frontend side of the shared effects library
 * (shared/fx/build.ts → manifest.json, mirrored by render/fxlib.rs).
 *
 * Owns everything that must agree byte-for-byte with Rust: parameter
 * validation and template expansion. `shared/fx/golden.json` pins the
 * expansions; both test suites compare against it.
 */

import raw from "../../../shared/fx/manifest.json" with { type: "json" };
import type { FxEntry, FxManifest, FxParam } from "../../../shared/fx/build.ts";

export type { FxEntry, FxParam, FxCategory, FxRender } from "../../../shared/fx/build.ts";

export const FX_MANIFEST = raw as unknown as FxManifest;

export const FX_CATEGORY_LABELS: Record<string, string> = {
  transitions: "Transitions",
  intro: "Intro",
  outro: "Outro",
  merge: "Merge",
  motion: "Motion",
  cinematic: "Cinematic",
  light: "Light",
  vfx: "VFX",
  audio: "Audio Reactive",
};

export const fxEntries = (): FxEntry[] => FX_MANIFEST.entries;
export const fxEntry = (id: string): FxEntry | undefined =>
  FX_MANIFEST.entries.find((e) => e.id === id);
export const fxTransition = (id: string): FxEntry | undefined => {
  const e = fxEntry(id);
  return e?.kind === "transition" ? e : undefined;
};

export function defaultParams(e: FxEntry): Record<string, number> {
  return Object.fromEntries(e.params.map((p) => [p.key, p.def]));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Clamp one value into its spec. Mirrors fxlib.rs::sanitize. */
export function sanitizeParam(spec: FxParam, v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return spec.def;
  switch (spec.type) {
    case "enum":
      return clamp(Math.round(v), 0, (spec.options?.length ?? 1) - 1);
    case "bool":
      return v >= 0.5 ? 1 : 0;
    case "color":
      return clamp(Math.round(v), 0, 0xffffff);
    default:
      return clamp(v, spec.min ?? -Infinity, spec.max ?? Infinity);
  }
}

/** Validate a param map against the manifest: unknown keys are dropped,
 *  missing/NaN/out-of-range values fall back to default/clamped. `warnings`
 *  lists what had to be corrected (never throws — bad data degrades). */
export function validateParams(
  e: FxEntry,
  params: Record<string, number> | undefined,
): { params: Record<string, number>; warnings: string[] } {
  const warnings: string[] = [];
  const out: Record<string, number> = {};
  for (const spec of e.params) {
    const v = params?.[spec.key];
    const s = sanitizeParam(spec, v);
    if (v !== undefined && s !== v) warnings.push(`${e.id}.${spec.key}: ${v} → ${s}`);
    out[spec.key] = s;
  }
  for (const k of Object.keys(params ?? {}))
    if (!e.params.some((p) => p.key === k)) warnings.push(`${e.id}.${k}: unknown param dropped`);
  return { params: out, warnings };
}

/** Capabilities (analysis artifacts) the entry needs but this build lacks. */
export function missingCapabilities(e: FxEntry): string[] {
  return (e.requires ?? []).filter((c) => !FX_MANIFEST.capabilities[c]);
}

// ── template expansion ────────────────────────────────────────────────

/** Deterministic number text shared with Rust: integers verbatim, else 6
 *  decimals trimmed; negatives parenthesised so `a-{x}` stays valid. */
export function fmtNum(v: number): string {
  let s = Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return v < 0 ? `(${s})` : s;
}

/** Param values + derived constants for an entry (validated first). */
export function resolveConstants(
  e: FxEntry,
  params: Record<string, number> | undefined,
): Record<string, number> {
  const { params: p } = validateParams(e, params);
  const out = { ...p };
  for (const [name, d] of Object.entries(e.derive ?? {})) {
    const idx = clamp(Math.round(p[d.from] ?? 0), 0, d.values.length - 1);
    out[name] = d.values[idx];
  }
  return out;
}

/** Expand `{T}` (eased progress), `{u}` (linear progress, replaced by
 *  `uExpr`) and `{name}` placeholders in any recipe text. Throws on unknown
 *  names — a typo in the manifest must fail loudly in tests, never render
 *  garbage. Mirrors fxlib.rs::expand_text byte-for-byte. */
export function expandText(
  e: FxEntry,
  text: string,
  params: Record<string, number> | undefined,
  ease?: string,
  uExpr = "u",
): string {
  const easeName = ease && FX_MANIFEST.eases[ease] ? ease : (e.defaultEase ?? "linear");
  const consts = resolveConstants(e, params);
  return text
    .replace(/\{T\}/g, () => FX_MANIFEST.eases[easeName])
    .replace(/\{(\w+)\}/g, (_, name: string) => {
      if (name === "u") return `(${uExpr})`;
      if (!(name in consts)) throw new Error(`${e.id}: unknown placeholder {${name}}`);
      return fmtNum(consts[name]);
    });
}

export function expandTemplate(
  e: FxEntry,
  params: Record<string, number> | undefined,
  ease?: string,
  uExpr = "u",
): string {
  if (!e.expr) throw new Error(`${e.id}: no expr`);
  return expandText(e, e.expr, params, ease, uExpr);
}
