/**
 * Preview implementations of the manifest's `effect` entries.
 *
 * Params/labels/limits come from the manifest (single source); the preview
 * math lives here and mirrors `render/fxeffects.rs` through the shared
 * curves in envelopes.ts. Each effect is expressed with primitives the
 * browser composites on the GPU: SVG feColorMatrix/feOffset/
 * feComponentTransfer for colour work and a clip scale for zoom.
 */

import type { EffectDef, FxCtx } from "@/lib/effects";
import type { Effect } from "@/lib/project-types";
import { fxEntries, resolveConstants, type FxEntry } from "./manifest";
import {
  BEAT_EVERY,
  beatEnv,
  beatTimes,
  eqToRgb,
  heroFlash,
  heroScale,
  heroSplitPx,
  rgbEnv,
  rgbShift,
} from "./envelopes";

type Params = Record<string, number>;

/** Frame-quantised time: the render changes values per frame, so does this. */
const tq = (ctx: FxCtx) => Math.floor((ctx.relMs / 1000) * ctx.fps + 1e-9) / ctx.fps;

/** feColorMatrix keeping only colour channel `ch` (and the source alpha). */
const only = (ch: 0 | 1 | 2): string => {
  const rows = [0, 1, 2].flatMap((i) => {
    const r = [0, 0, 0, 0, 0];
    if (i === ch) r[ch] = 1;
    return r;
  });
  return `${rows.join(" ")} 0 0 0 1 0`;
};

/** R/B channel split by integer px (bbox-relative so it scales with the
 *  element); G stays. Same result as ffmpeg's rgbashift for opaque layers. */
function splitSvg(rh: number, rv: number, ctx: FxCtx): string {
  if (!rh && !rv) return "";
  const dx = rh / ctx.layerW;
  const dy = rv / ctx.layerH;
  return [
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${only(0)}" result="fxR"/>`,
    `<feOffset in="fxR" dx="${dx}" dy="${dy}" result="fxRs"/>`,
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${only(1)}" result="fxG"/>`,
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${only(2)}" result="fxB"/>`,
    `<feOffset in="fxB" dx="${-dx}" dy="${-dy}" result="fxBs"/>`,
    `<feComposite in="fxRs" in2="fxG" operator="arithmetic" k2="1" k3="1" result="fxRG"/>`,
    `<feComposite in="fxRG" in2="fxBs" operator="arithmetic" k2="1" k3="1"/>`,
  ].join("");
}

/** Equal RGB offset = ffmpeg `eq` brightness (luma-only shift). */
const brightnessSvg = (b: number): string => {
  if (b <= 1e-4) return "";
  const i = eqToRgb(b).toFixed(5);
  return `<feComponentTransfer>${["R", "G", "B"].map((c) => `<feFunc${c} type="linear" slope="1" intercept="${i}"/>`).join("")}</feComponentTransfer>`;
};

const IMPL: Record<string, Partial<EffectDef>> = {
  rgbDisplacement: {
    // Known preview↔export difference (documented, not fixable cheaply):
    // ffmpeg's `rgbashift` repeats the edge pixel along the shift direction,
    // so the export smears the R/B channels in a strip up to `amount`% wide
    // at the left/right (or top/bottom) frame edges. The SVG preview leaves
    // that strip empty. Only affects content that touches the shifted edge;
    // interior pixels are identical.
    toSvg: (ps: Params, ctx?: FxCtx) => {
      if (!ctx) return "";
      const p = resolveConstantsFor("rgbDisplacement", ps);
      const [rh, rv] = rgbShift(p.amount, p.angle, rgbEnv(p.mode, p.speed, tq(ctx)), ctx.canvasW);
      return splitSvg(rh, rv, ctx);
    },
  },
  heroEntrance: {
    toScale: (ps: Params, ctx: FxCtx) => {
      const p = resolveConstantsFor("heroEntrance", ps);
      return p.zoom > 0 ? Math.max(1, heroScale(p.zoom, p.duration / 1000, tq(ctx))) : 1;
    },
    toSvg: (ps: Params, ctx?: FxCtx) => {
      if (!ctx) return "";
      const p = resolveConstantsFor("heroEntrance", ps);
      const t = tq(ctx);
      const d = p.duration / 1000;
      return (
        brightnessSvg(heroFlash(p.flash, d, t)) +
        splitSvg(heroSplitPx(p.split, ctx.canvasW, d, t), 0, ctx)
      );
    },
  },
  beatImpact: {
    toScale: (ps: Params, ctx: FxCtx, fx: Effect) => {
      const p = resolveConstantsFor("beatImpact", ps);
      if (p.zoom <= 0) return 1;
      const beats = beatTimes(fx.times, BEAT_EVERY[p.every], p.offset, ctx);
      return Math.max(1, 1 + p.zoom * beatEnv(beats, p.decay, tq(ctx)));
    },
    toSvg: (ps: Params, ctx?: FxCtx, fx?: Effect) => {
      if (!ctx || !fx) return "";
      const p = resolveConstantsFor("beatImpact", ps);
      if (p.flash <= 0) return "";
      const beats = beatTimes(fx.times, BEAT_EVERY[p.every], p.offset, ctx);
      return brightnessSvg(0.3 * p.flash * beatEnv(beats, p.decay, tq(ctx)));
    },
  },
};

const resolveConstantsFor = (id: string, ps: Params) =>
  resolveConstants(fxEntries().find((e) => e.id === id)!, ps);

/** EffectDefs for every manifest `effect` entry (params from the manifest). */
export function libraryEffectDefs(): EffectDef[] {
  return fxEntries()
    .filter((e: FxEntry) => e.kind === "effect")
    .map((e) => ({
      type: e.id,
      fxId: e.id,
      label: e.name,
      glPreview: e.preview === "gl" && e.kind === "effect",
      params: Object.fromEntries(
        e.params.map((p) => [
          p.key,
          p.type === "enum"
            ? { def: p.def, min: 0, max: (p.options?.length ?? 1) - 1, step: 1 }
            : { def: p.def, min: p.min ?? 0, max: p.max ?? 1, step: p.step ?? 0.01 },
        ]),
      ),
      ...IMPL[e.id],
    }));
}
