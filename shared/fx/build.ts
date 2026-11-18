/**
 * FX manifest generator — the single source of truth for the effects
 * library. `manifest.json` is GENERATED from this file
 * (`npm run fx:manifest`) and consumed by BOTH sides:
 *
 *  - TypeScript: src/lib/fx/manifest.ts (UI, validation, GLSL transpile)
 *  - Rust:       src-tauri/src/render/fxlib.rs (`include_str!`, validation,
 *                ffmpeg expansion)
 *
 * A vitest guard fails when the checked-in manifest drifts from this file.
 *
 * ── Two views of one transition ───────────────────────────────────────
 * `expr` is the SPECIFICATION: the transition as a per-pixel function in
 * ffmpeg's expression dialect. The preview transpiles it to GLSL and tests
 * run it through a CPU interpreter / real `xfade=custom`.
 *
 * Evaluating `expr` per pixel inside ffmpeg is far too slow for export
 * (measured: ~0.5 s/frame at 1080p for a 6-tap blur; `st/ld` also races
 * across xfade's slice threads). So the render uses `render`, a native
 * graph built in Rust from the SAME declarative parts:
 *   strip  — [A|B] stacked, crop windows averaged with `mix` (slides/pushes)
 *   fields — displacement/mask fields evaluated by `geq` at 1/div
 *            resolution, upscaled, applied with native `remap`+`maskedmerge`
 * A Rust test renders both paths and bounds their PSNR.
 *
 * Dialect:  X Y W H  pixel coords / canvas size (Y=0 is the TOP row)
 *           u        linear progress 0→1;  {T} = ease(u)
 *           SA(x,y) SB(x,y)  outgoing/incoming clip, nearest + edge-clamped
 *           {name}   numeric param (placeholder)
 */

export type FxCategory =
  | "transitions"
  | "intro"
  | "outro"
  | "merge"
  | "motion"
  | "cinematic"
  | "vfx"
  | "audio"
  // Creative-filter families (kind:"filter")
  | "vintage"
  | "aesthetic"
  | "moody"
  | "modern"
  | "mono"
  // Light & atmosphere effects (kind:"effect", preview:"gl")
  | "light";

/**
 * Color ops baked into a filter's 33³ .cube. Each is a pure function on
 * display-referred RGB (0..1) evaluated identically by the TS baker
 * (`src/lib/fx/lut.ts` → GL 3D texture) and the Rust baker
 * (`render/fxlut.rs` → lut3d file). `Num` is a literal or a `{param}`
 * placeholder resolved through `resolveConstants` — so color tunables can
 * become user params later without a schema change.
 */
export type Num = number | `{${string}}`;
export type V3 = [Num, Num, Num];

export type LutOp =
  | { op: "temp"; amt: Num } // −1 cool … +1 warm (white-balance axis)
  | { op: "tint"; amt: Num } // −1 green … +1 magenta
  | { op: "sat"; amt: Num } // saturation multiplier (1 = neutral)
  | { op: "vib"; amt: Num } // vibrance: saturation weighted toward low-sat pixels
  | { op: "lgg"; lift: V3; gamma: V3; gain: V3 } // lift/γ/gain, ASC-style
  | { op: "curve"; ch: Num; pts: [number, number][] } // 0..2 = R/G/B, 3 = all
  | { op: "split"; sh: [Num, Num]; hi: [Num, Num] } // [hue°, strength] shadows/highlights
  | { op: "mixer"; m: number[][] } // 3×3 channel mix
  | { op: "hsl"; hue: Num; range: Num; dh: Num; ds: Num; dl: Num } // selective hue
  | { op: "fade"; amt: Num } // black-point lift + white compression
  | { op: "levels"; inB: Num; inW: Num; outB: Num; outW: Num; gamma: Num };

export interface FxParam {
  key: string;
  label: string;
  type: "number" | "angle" | "color" | "enum" | "bool";
  def: number;
  min?: number;
  max?: number;
  step?: number;
  /** enum labels — the stored value is the option index. */
  options?: string[];
  unit?: string;
}

export type FxRender =
  | { kind: "strip" }
  | {
      kind: "fields";
      /** Field resolution divisor (fields are evaluated at 1/div size). */
      div: number;
      /** ax/ay: source px of the outgoing clip; m: 0..1 weight of the
       *  outgoing clip (0 = incoming). Templates in the dialect. */
      fields: { ax: string; ay: string; m: string };
    };

export interface FxEntry {
  id: string;
  kind: "transition" | "effect" | "filter";
  category: FxCategory;
  name: string;
  description: string;
  params: FxParam[];
  /** Constants derived from an enum param: value = values[index]. */
  derive?: Record<string, { from: string; values: number[] }>;
  /** Transition SPECIFICATION (see header): per-pixel recipe template used
   *  by the preview (GLSL) and as the test oracle for the native render. */
  expr?: string;
  /** Native render strategy (see header). */
  render?: FxRender;
  defaultDurationMs?: number;
  defaultEase?: string;
  /** Hard prerequisites (capabilities) — the UI blocks apply without them. */
  requires?: string[];
  /** Capabilities that enhance the effect when present (never required). */
  optionalInputs?: string[];
  /** Color ops baked into the filter's 33³ LUT (kind:"filter" only). */
  lut?: LutOp[];
  /** How the editor preview renders it. */
  preview: "gl" | "svg" | "css" | "none";
  /** CSS class of the animated thumbnail (index.css) — or `img:` filename
   *  for baked thumbnails under shared/fx/thumbs/ (filters). */
  thumb: string;
}

export interface FxManifest {
  version: 1;
  /** Ease curves over linear progress `{u}` (0→1): value = 0→1. */
  eases: Record<string, string>;
  /** Analysis capabilities this build can actually provide. A future
   *  segmentation module flips `subjectMask` and the entries that list it
   *  in `optionalInputs` start using it — no effect rewrite needed. */
  capabilities: Record<string, boolean>;
  entries: FxEntry[];
}

// ── ease curves ────────────────────────────────────────────────────────
const eases: Record<string, string> = {
  linear: "{u}",
  easeIn: "({u}*{u})",
  easeOut: "(1-(1-{u})*(1-{u}))",
  easeInOut: "({u}*{u}*(3-2*{u}))",
  easeInCubic: "({u}*{u}*{u})",
  easeOutCubic: "(1-pow(1-{u},3))",
  easeInOutCubic: "if(lt({u},0.5),4*{u}*{u}*{u},1-pow(2-2*{u},3)/2)",
  easeOutExpo: "if(eq({u},1),1,1-pow(2,0-10*{u}))",
};

const T = "{T}";

// ── Velocity Swipe ─────────────────────────────────────────────────────
// A slides out along `direction`, B slides in right behind it. The blur
// length follows a bell curve (peak mid-swipe), sampled with TAPS along the
// motion axis over the *composited* result so the seam blurs too.
// Spec math:  A source = X + dx·W·(s·M − T)   B source = X + dx·W·(s·M + 1 − T)
// with M = blur·sin(π·T) the bell-shaped blur length and s the tap offset.
// Native render (`strip`): the same thing as a window sliding over [A|B].
function velocitySwipeExpr(taps = 6): string {
  const M = `{blur}*sin(PI*${T})`;
  const one = (k: number) => {
    const s = (k / (taps - 1) - 0.5).toFixed(4);
    const ax = `(X+{dx}*W*(${s}*${M}-${T}))`;
    const ay = `(Y+{dy}*H*(${s}*${M}-${T}))`;
    const bx = `(X+{dx}*W*(${s}*${M}+1-${T}))`;
    const by = `(Y+{dy}*H*(${s}*${M}+1-${T}))`;
    return `if(between(${ax},0,W-1)*between(${ay},0,H-1),SA(${ax},${ay}),SB(${bx},${by}))`;
  };
  const sum = Array.from({ length: taps }, (_, k) => one(k)).join("+");
  return `(${sum})/${taps}`;
}

const MELT = (() => {
  const x = "(X/W)";
  const v = "(Y/H)";
  const col = `(0.5+0.5*sin(${x}*37.7)*sin(${x}*11.3+1.3))`;
  // T appears twice in the front: once as the sweep, once inside the wave.
  const fy = `(${T}*(1.5+{drip}*0.5+{drip}*0.3*${col})-0.25+{wave}*sin(${x}*{freq}*6.2832+${T}*5))`;
  const dist = `(${v}-${fy})`;
  // One shared decay exp(-4.5·dist) scales both the drip and the wobble.
  const fall = `exp(0-${dist}*4.5)*sin(PI*${T})`;
  const stretch = `({drip}*0.5*H*${fall}*${col})`;
  const wob = `({wobble}*0.03*W*${fall}*sin(${v}*40+${T}*12))`;
  return {
    ax: `X+${wob}`,
    ay: `Y-${stretch}`,
    m: `if(lt(${dist},0),0,clip(${dist}/0.04,0,1))`,
  };
})();

// ── Liquid Melt ────────────────────────────────────────────────────────
// A front sweeps top→bottom with a wavy edge; below it the outgoing frame
// sags into per-column drips (vertical stretch) and wobbles sideways, the
// incoming frame appears above. Column drip lengths come from a product of
// sines (deterministic, float32-safe — no sin-hash).
const liquidMeltExpr = () =>
  `(${MELT.m})*SA(${MELT.ax},${MELT.ay})+(1-(${MELT.m}))*SB(X,Y)`;

const num = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  step: number,
  unit?: string,
): FxParam => ({ key, label, type: "number", def, min, max, step, ...(unit ? { unit } : {}) });

export const MANIFEST: FxManifest = {
  version: 1,
  eases,
  capabilities: { beats: true, subjectMask: false },
  entries: [
    {
      id: "velocitySwipe",
      kind: "transition",
      category: "transitions",
      name: "Velocity Swipe",
      description:
        "Fast whip-pan to the next clip with directional motion blur that peaks mid-swipe.",
      params: [
        { key: "direction", label: "Direction", type: "enum", def: 0, options: ["Left", "Right", "Up", "Down"] },
        num("blur", "Motion blur", 0.16, 0, 0.4, 0.01),
      ],
      derive: {
        dx: { from: "direction", values: [-1, 1, 0, 0] },
        dy: { from: "direction", values: [0, 0, -1, 1] },
      },
      expr: velocitySwipeExpr(),
      render: { kind: "strip" },
      defaultDurationMs: 500,
      defaultEase: "easeInOutCubic",
      preview: "gl",
      thumb: "fxt-swipe",
    },
    {
      id: "liquidMelt",
      kind: "transition",
      category: "transitions",
      name: "Liquid Melt",
      description:
        "The outgoing clip melts downward in wavy drips, revealing the next clip underneath.",
      params: [
        num("drip", "Drip length", 0.6, 0, 1, 0.01),
        num("wave", "Wave", 0.06, 0, 0.12, 0.005),
        num("freq", "Wave count", 3, 1, 8, 0.5),
        num("wobble", "Side wobble", 0.5, 0, 1, 0.01),
      ],
      expr: liquidMeltExpr(),
      render: { kind: "fields", div: 8, fields: MELT },
      defaultDurationMs: 900,
      defaultEase: "easeInOut",
      preview: "gl",
      thumb: "fxt-melt",
    },
    {
      id: "rgbDisplacement",
      kind: "effect",
      category: "vfx",
      name: "RGB Displacement",
      description:
        "Splits the red and blue channels apart along an angle — static, pulsing to a rhythm, or glitching in bursts.",
      params: [
        num("amount", "Distance", 1.2, 0, 5, 0.05, "% width"),
        { key: "angle", label: "Angle", type: "angle", def: 0, min: 0, max: 360, step: 5, unit: "°" },
        { key: "mode", label: "Mode", type: "enum", def: 1, options: ["Static", "Pulse", "Glitch"] },
        num("speed", "Speed", 3, 0.5, 8, 0.5, "Hz"),
      ],
      preview: "svg",
      thumb: "fxt-rgb",
    },
    {
      id: "heroEntrance",
      kind: "effect",
      category: "intro",
      name: "Hero Entrance",
      description:
        "Impact entrance for the whole clip: a fast zoom-slam with an exposure flash and a decaying RGB split.",
      params: [
        num("duration", "Duration", 900, 300, 2500, 50, "ms"),
        num("zoom", "Zoom slam", 0.22, 0, 0.6, 0.01),
        num("flash", "Flash", 0.5, 0, 1, 0.01),
        num("split", "RGB split", 1.0, 0, 4, 0.05, "% width"),
      ],
      preview: "svg",
      optionalInputs: ["subjectMask"],
      thumb: "fxt-hero",
    },
    {
      id: "beatImpact",
      kind: "effect",
      category: "audio",
      name: "Beat Impact",
      description:
        "Punches the picture on every detected percussive hit: a zoom pulse and exposure flash that decay between beats.",
      params: [
        num("zoom", "Zoom punch", 0.08, 0, 0.3, 0.005),
        num("flash", "Flash", 0.25, 0, 1, 0.01),
        num("decay", "Decay", 8, 2, 20, 0.5, "/s"),
        { key: "every", label: "Hit on", type: "enum", def: 0, options: ["Every beat", "Every 2nd", "Every 4th"] },
        num("offset", "Sync offset", 0, -200, 200, 5, "ms"),
        num("sensitivity", "Sensitivity", 0.5, 0, 1, 0.05),
      ],
      requires: ["beats"],
      preview: "svg",
      thumb: "fxt-beat",
    },
    // ── Creative filters (kind:"filter") ────────────────────────────────
    // Color identity lives in `lut` (baked 33³ .cube — exact preview↔export
    // parity via texture3D / lut3d:interp=trilinear). Spatial stages are a
    // fixed canonical pipeline driven by convention-named params:
    //   vig · grain · bloom · hal · ca · sharp · soft   (each 0..1)
    // plus `intensity` (0..100, %). Stages run in this order on BOTH sides:
    //   lut → ca → bloom → hal → vignette → sharp/soft → grain
    // Params not declared by an entry default to 0 (stage skipped).
    // ── Golden Film ─────────────────────────────────────────────────
    // Kodak-Gold-style warm analog stock: golden highlights, warm mids,
    // gently lifted blacks, the soft warm bleed around bright areas that
    // film halation gives, and a visible-but-fine grain.
    {
      id: "goldenFilm",
      kind: "filter",
      category: "vintage",
      name: "Golden Film",
      description:
        "Warm analog stock — golden highlights, sunlit mids, soft blacks, film halation and fine grain.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("hal", "Halation", 0.3, 0, 1, 0.01),
        num("grain", "Film grain", 0.3, 0, 1, 0.01),
        num("vig", "Vignette", 0.15, 0, 1, 0.01),
      ],
      lut: [
        { op: "temp", amt: 0.14 },
        { op: "curve", ch: 3, pts: [[0, 0.02], [0.3, 0.3], [0.7, 0.72], [1, 0.98]] },
        { op: "curve", ch: 0, pts: [[0, 0.01], [0.5, 0.51], [1, 0.99]] },
        { op: "curve", ch: 2, pts: [[0, 0.05], [0.5, 0.47], [1, 0.95]] },
        { op: "split", sh: [45, 0.1], hi: [46, 0.17] },
        { op: "hsl", hue: 85, range: 45, dh: -12, ds: 1.05, dl: 0.02 },
        { op: "hsl", hue: 32, range: 40, dh: 4, ds: 1.08, dl: 0.02 },
        { op: "vib", amt: 1.08 },
        { op: "fade", amt: 0.05 },
      ],
      preview: "gl",
      thumb: "img:goldenFilm",
    },
    // ── Dreamy ──────────────────────────────────────────────────────
    // Soft-focus editorial: full color richness kept (pastel comes from
    // split-toning, not desaturation), blacks stay deep, highlights bloom
    // warm, and a peach/pink/lavender palette keeps skin warm and alive —
    // pro diffusion-filter photography, not washed-out fade.
    {
      id: "dreamy",
      kind: "filter",
      category: "aesthetic",
      name: "Dreamy",
      description:
        "Soft-focus editorial glow — peach-lavender split tone, blooming highlights, rich pastel color.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("bloom", "Glow", 0.5, 0, 1, 0.01),
        num("soft", "Diffusion", 0.35, 0, 1, 0.01),
        num("vig", "Vignette", 0.1, 0, 1, 0.01),
      ],
      lut: [
        { op: "temp", amt: 0.02 },
        { op: "tint", amt: 0.05 },
        // Soft top compression only — depth and blacks stay intact.
        { op: "curve", ch: 3, pts: [[0, 0.015], [0.5, 0.5], [0.85, 0.86], [1, 0.97]] },
        // Lavender shadows, pink-peach highlights — the pastel lives here.
        { op: "split", sh: [275, 0.1], hi: [338, 0.11] },
        // Skin/warm hues nudged toward peach-pink, luminance lifted a touch.
        { op: "hsl", hue: 20, range: 40, dh: -8, ds: 1.0, dl: 0.04 },
        // Rich color: vibrance does the lifting, saturation stays near 1.
        { op: "vib", amt: 1.12 },
        { op: "sat", amt: 0.97 },
        { op: "fade", amt: 0.04 },
      ],
      preview: "gl",
      thumb: "img:dreamy",
    },
    {
      id: "tealOrange",
      kind: "filter",
      category: "cinematic",
      name: "Teal & Orange",
      description:
        "Blockbuster grade — teal-pushed shadows and foliage, warm orange skin and highlights, punchy S-curve.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("vig", "Vignette", 0.26, 0, 1, 0.01),
        num("grain", "Film grain", 0.12, 0, 1, 0.01),
        num("ca", "Chromatic edge", 0.15, 0, 1, 0.01),
      ],
      lut: [
        // Controlled S: low-mids lifted to keep landscape/faces readable,
        // blacks keep depth, highlights untouched.
        { op: "curve", ch: 3, pts: [[0, 0.01], [0.12, 0.155], [0.35, 0.375], [0.65, 0.66], [0.85, 0.88], [1, 1]] },
        { op: "split", sh: [200, 0.13], hi: [32, 0.22] },
        { op: "hsl", hue: 35, range: 45, dh: -4, ds: 1.14, dl: 0.06 },
        { op: "hsl", hue: 210, range: 65, dh: -8, ds: 1.05, dl: 0.02 },
        { op: "sat", amt: 1.08 },
      ],
      preview: "gl",
      thumb: "img:tealOrange",
    },
    // ── Disposable Camera ───────────────────────────────────────────
    // 90s one-time-use camera: direct-flash exposure (hot mids, ambient
    // falloff at the edges), cheap-film color crossover — warm amber
    // highlights against slightly green shadows — imperfect hue
    // reproduction, coarse grain and a fixed-focus plastic lens.
    {
      id: "disposable",
      kind: "filter",
      category: "vintage",
      name: "Disposable Camera",
      description:
        "90s flash snapshot — hot warm highlights, greenish shadows, coarse grain, plastic-lens softness.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("vig", "Flash falloff", 0.45, 0, 1, 0.01),
        num("grain", "Film grain", 0.68, 0, 1, 0.01),
        num("soft", "Lens softness", 0.22, 0, 1, 0.01),
        num("ca", "Lens fringing", 0.28, 0, 1, 0.01),
        num("bloom", "Flash bloom", 0.22, 0, 1, 0.01),
      ],
      lut: [
        // Direct flash: subject mids pushed hot, top clipped early and
        // flat — the slightly blown, harsh on-camera-flash exposure.
        { op: "curve", ch: 3, pts: [[0, 0.07], [0.3, 0.42], [0.6, 0.7], [0.85, 0.9], [1, 0.95]] },
        // Drugstore crossover, turned up: green-cyan shadows, warm
        // amber-orange highlights, slight magenta in the very top.
        { op: "split", sh: [155, 0.15], hi: [46, 0.18] },
        { op: "temp", amt: 0.08 },
        { op: "tint", amt: 0.03 },
        // Imperfect color reproduction, cranked: greens go mustard,
        // reds oversaturate toward orange, blues go murky teal —
        // cheap emulsion + one-hour lab scan, not clean digital color.
        { op: "hsl", hue: 90, range: 60, dh: -22, ds: 0.9, dl: 0.02 },
        { op: "hsl", hue: 8, range: 50, dh: 12, ds: 1.15, dl: 0 },
        { op: "hsl", hue: 225, range: 60, dh: -18, ds: 0.82, dl: -0.01 },
        { op: "hsl", hue: 315, range: 45, dh: -10, ds: 0.9, dl: 0 },
        { op: "sat", amt: 1.1 },
        { op: "fade", amt: 0.05 },
      ],
      preview: "gl",
      thumb: "img:disposable",
    },
    // ── Cyber Neon ──────────────────────────────────────────────────
    // Neon-night aesthetic: the palette is rotated into the
    // cyan/magenta/violet triad by selective hue shifts — never a global
    // saturation bump. Deep moody mids, luminous electric highlights,
    // controlled chromatic separation at the edges.
    {
      id: "cyberNeon",
      kind: "filter",
      category: "modern",
      name: "Cyber Neon",
      description:
        "Neon nightlife — cyan, magenta and violet pulled from every hue, glowing highlights, electric edges.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("bloom", "Neon glow", 0.5, 0, 1, 0.01),
        num("ca", "Chromatic split", 0.4, 0, 1, 0.01),
        num("hal", "Light bleed", 0.2, 0, 1, 0.01),
        num("vig", "Vignette", 0.2, 0, 1, 0.01),
      ],
      lut: [
        { op: "temp", amt: -0.18 },
        // Night mood: mids sink deeper, highlights stay hot and electric.
        { op: "curve", ch: 3, pts: [[0, 0.03], [0.4, 0.33], [0.7, 0.7], [1, 0.98]] },
        // Violet shadows, electric-cyan highlights — the neon split.
        { op: "split", sh: [280, 0.3], hi: [188, 0.22] },
        // A magenta veil in the mids so the triad reads, not just cyan.
        { op: "tint", amt: 0.05 },
        // Hue rotation into the triad: greens→cyan, reds/oranges→magenta,
        // blues→violet-cyan. Saturation changes are per-hue, not global.
        { op: "hsl", hue: 100, range: 60, dh: 60, ds: 1.2, dl: 0 },
        { op: "hsl", hue: 5, range: 40, dh: 35, ds: 1.15, dl: 0 },
        // Skin-hue shelter: keep faces warm-ish under the magenta veil.
        { op: "hsl", hue: 28, range: 26, dh: -14, ds: 0.9, dl: 0.02 },
        { op: "hsl", hue: 215, range: 55, dh: -15, ds: 1.3, dl: 0 },
        // Punch the already-electric hues, lightly lift them.
        { op: "hsl", hue: 190, range: 45, dh: 0, ds: 1.35, dl: 0.02 },
        { op: "hsl", hue: 315, range: 50, dh: 0, ds: 1.35, dl: 0.02 },
        { op: "sat", amt: 1.04 },
      ],
      preview: "gl",
      thumb: "img:cyberNeon",
    },
    // ── Dark Mood ───────────────────────────────────────────────────
    // Dramatic cinematic darkness: rich deep blacks, compressed
    // controlled highlights, muted color — but warm hues keep a faint
    // ember so faces and subjects never die. Steel-teal shadows,
    // hard vignette, crisp edges, quiet grain.
    {
      id: "darkMood",
      kind: "filter",
      category: "moody",
      name: "Dark Mood",
      description:
        "Cinematic noir — rich blacks, sunken mids, muted color, a warm ember left in skin tones.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("vig", "Vignette", 0.4, 0, 1, 0.01),
        num("grain", "Film grain", 0.15, 0, 1, 0.01),
        num("sharp", "Edge detail", 0.25, 0, 1, 0.01),
      ],
      lut: [
        { op: "temp", amt: -0.03 },
        // Deep toe and sunken mids, controlled top — detail survives in
        // the low band, blacks stay rich (never faded). Subject mids get
        // a touch more air than the background.
        { op: "curve", ch: 3, pts: [[0, 0], [0.12, 0.11], [0.35, 0.33], [0.6, 0.57], [0.85, 0.82], [1, 0.95]] },
        // Steel-teal shadows, barely-warm highlights.
        { op: "split", sh: [215, 0.1], hi: [38, 0.07] },
        // Muted color across the board…
        { op: "sat", amt: 0.74 },
        { op: "vib", amt: 0.9 },
        // …but warm skin hues keep a touch of life and luminance —
        // nudged warm so faces don't go green under the teal shadows.
        { op: "hsl", hue: 28, range: 42, dh: 6, ds: 1.18, dl: 0.05 },
        // Blues go slate, greens go moss — nothing saturated survives.
        { op: "hsl", hue: 210, range: 60, dh: -8, ds: 0.9, dl: -0.01 },
        { op: "hsl", hue: 95, range: 55, dh: -15, ds: 0.85, dl: -0.01 },
      ],
      preview: "gl",
      thumb: "img:darkMood",
    },
    // ── Luxury ──────────────────────────────────────────────────────
    // Premium fashion/editorial grade: refined neutral palette, creamy
    // lifted shadows, elegant highlight rolloff, luminous skin — rich
    // without raw saturation, cool-neutral without going cold.
    {
      id: "luxury",
      kind: "filter",
      category: "modern",
      name: "Luxury",
      description:
        "Editorial polish — creamy shadows, luminous skin, sophisticated neutral palette, refined contrast.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("sharp", "Editorial detail", 0.2, 0, 1, 0.01),
        num("bloom", "Highlight sheen", 0.12, 0, 1, 0.01),
        num("vig", "Vignette", 0.14, 0, 1, 0.01),
        num("grain", "Film grain", 0.08, 0, 1, 0.01),
      ],
      lut: [
        { op: "temp", amt: -0.02 },
        // Fashion contrast: blacks lifted to cream, mids honest, top
        // rolls off elegantly instead of clipping.
        { op: "curve", ch: 3, pts: [[0, 0.045], [0.25, 0.29], [0.55, 0.56], [0.8, 0.82], [1, 0.97]] },
        // Cool slate shadows against clean ivory highlights — neutral
        // sophistication, not warmth.
        { op: "split", sh: [225, 0.11], hi: [45, 0.05] },
        // Elegant skin: warm hues stay true but gain a soft luminance
        // lift — retouched, not recolored.
        { op: "hsl", hue: 30, range: 42, dh: 2, ds: 0.95, dl: 0.05 },
        // Restrained color — richness comes from vibrance on flat areas.
        { op: "sat", amt: 0.86 },
        { op: "vib", amt: 1.1 },
      ],
      preview: "gl",
      thumb: "img:luxury",
    },
    // ── Soft Glow ───────────────────────────────────────────────────
    // Genuine optical diffusion (Pro-Mist / Black Diffusion): color
    // stays faithful — the identity lives in the spatial chain. Light
    // scattering, beautiful highlight bloom, subtle halation, mild
    // contrast veiling. Detail preserved — not a blurry frame.
    {
      id: "softGlow",
      kind: "filter",
      category: "aesthetic",
      name: "Soft Glow",
      description:
        "Optical diffusion — blooming luminous highlights, gentle light scatter, faithful color and detail.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("bloom", "Glow", 0.62, 0, 1, 0.01),
        num("hal", "Halation", 0.35, 0, 1, 0.01),
        num("soft", "Light scatter", 0.32, 0, 1, 0.01),
      ],
      lut: [
        // Faithful color with only the optical veil: slight contrast
        // give at toe and top, exactly what diffusion does to light.
        // Highlights lifted a touch so the bloom has light to catch.
        { op: "curve", ch: 3, pts: [[0, 0.03], [0.4, 0.4], [0.7, 0.72], [1, 0.98]] },
        { op: "temp", amt: 0.02 },
        { op: "sat", amt: 0.98 },
      ],
      preview: "gl",
      thumb: "img:softGlow",
    },
    // ── Bleach Bypass ───────────────────────────────────────────────
    // Silver-retention process: strong cinematic contrast, restrained
    // (not absent) color, metallic silver highlights, deep blacks,
    // crunchy texture. Cool steel tonality — distinct from Dark Mood's
    // sunken-mid atmosphere.
    {
      id: "bleachBypass",
      kind: "filter",
      category: "cinematic",
      name: "Bleach Bypass",
      description:
        "Silver-retention cinema — hard contrast, steel-cool tonality, metallic highlights, gritty texture.",
      params: [
        num("intensity", "Intensity", 80, 0, 100, 1, "%"),
        num("sharp", "Texture", 0.35, 0, 1, 0.01),
        num("grain", "Film grain", 0.35, 0, 1, 0.01),
        num("vig", "Vignette", 0.28, 0, 1, 0.01),
      ],
      lut: [
        { op: "temp", amt: -0.1 },
        // Hard silver S: blacks crushed deep, mids punched down then up
        // hard — contrast, not underexposure. Highlights driven bright.
        // The 0.15–0.45 band is lifted (0.2→0.16, 0.45→0.45 out) so subjects
        // sitting in low mids keep facial detail under the crush.
        { op: "curve", ch: 3, pts: [[0, 0], [0.08, 0.028], [0.2, 0.16], [0.45, 0.45], [0.65, 0.72], [0.85, 0.92], [1, 1]] },
        // Steel-cool shadows and silver (cool-neutral) highlights.
        { op: "split", sh: [215, 0.12], hi: [222, 0.09] },
        // Restrained color — muted, not gone. Skin keeps a trace of life
        // plus a small luminance lift (dl) — faces stay readable.
        { op: "sat", amt: 0.42 },
        { op: "vib", amt: 0.85 },
        { op: "hsl", hue: 28, range: 42, dh: 0, ds: 1.25, dl: 0.04 },
        // Greens and blues drain toward steel.
        { op: "hsl", hue: 200, range: 70, dh: -5, ds: 0.82, dl: 0 },
        { op: "hsl", hue: 95, range: 55, dh: -10, ds: 0.75, dl: -0.02 },
      ],
      preview: "gl",
      thumb: "img:bleachBypass",
    },
    // ── Monochrome ──────────────────────────────────────────────────
    // Premium black-and-white: a real luminance-aware channel mix (not
    // sat-0 desaturation) tuned like a panchromatic film with an orange
    // filter — skin opens up, skies darken. Rich tonal separation,
    // deep detailed blacks, controlled top, whisper of print toning.
    {
      id: "monochrome",
      kind: "filter",
      category: "mono",
      name: "Monochrome",
      description:
        "Fine-art B&W — channel-mixed luminance, rich separation, deep detailed blacks, silver-print finish.",
      params: [
        num("intensity", "Intensity", 85, 0, 100, 1, "%"),
        num("sharp", "Detail", 0.25, 0, 1, 0.01),
        num("grain", "Film grain", 0.22, 0, 1, 0.01),
        num("vig", "Vignette", 0.18, 0, 1, 0.01),
      ],
      lut: [
        // Luminance-aware mix: orange-filter weighting lifts skin/reds,
        // darkens blues — richer separation than luma desaturation.
        { op: "mixer", m: [[0.45, 0.42, 0.13], [0.45, 0.42, 0.13], [0.45, 0.42, 0.13]] },
        // Fine-art tone curve: deep toe with detail retained, honest
        // mids, whites held just under the paper white.
        { op: "curve", ch: 3, pts: [[0, 0.01], [0.15, 0.12], [0.5, 0.51], [0.85, 0.88], [1, 0.98]] },
        // Whisper of darkroom toning: cool selenium shadows, warm
        // fiber-paper highlights — barely visible, adds depth.
        { op: "split", sh: [225, 0.04], hi: [42, 0.04] },
        { op: "levels", inB: 0.02, inW: 0.99, outB: 0.01, outW: 0.97, gamma: 1.05 },
      ],
      preview: "gl",
      thumb: "img:monochrome",
    },
    // ── Light & Atmosphere (kind:"effect", preview:"gl") ─────────────
    // Procedural light/optics — NOT color grades. Preview: dedicated GLSL
    // programs in the shared filter compositor (gl-effects.ts). Export:
    // baked geq sprites + animated overlay/rotate/blend fragments
    // (fxeffects.rs). Motion curves live in envelopes.ts, mirrored in Rust
    // and pinned by curves.golden.json.
    // ── Cinematic Lens Flare ────────────────────────────────────────
    // Anamorphic horizontal streak with a hot core and optional ghost
    // reflections, screen-blended. The flare drifts slowly around the
    // user-set anchor (speed) and breathes (flicker).
    {
      id: "lensFlare",
      kind: "effect",
      category: "light",
      name: "Cinematic Lens Flare",
      description:
        "Anamorphic light streak with a hot core and ghost reflections that drifts slowly — cinema-grade flare, not a grade.",
      params: [
        num("intensity", "Intensity", 70, 0, 100, 1, "%"),
        num("x", "Position X", 62, 0, 100, 1, "%"),
        num("y", "Position Y", 38, 0, 100, 1, "%"),
        {
          key: "hue",
          label: "Tint",
          type: "enum",
          def: 0,
          options: ["Ice Blue", "Warm", "Magenta"],
        },
        {
          key: "elements",
          label: "Elements",
          type: "enum",
          def: 1,
          options: ["Streak + Core", "+ 2 Ghosts", "+ 4 Ghosts"],
        },
        num("spread", "Streak width", 1, 0.4, 2, 0.05),
        num("speed", "Drift speed", 0.12, 0, 0.6, 0.01, "Hz"),
        num("flicker", "Flicker", 0.3, 0, 0.6, 0.02),
      ],
      derive: {
        cr: { from: "hue", values: [0.55, 1.0, 1.0] },
        cg: { from: "hue", values: [0.75, 0.82, 0.5] },
        cb: { from: "hue", values: [1.0, 0.55, 0.85] },
        ghosts: { from: "elements", values: [0, 2, 4] },
      },
      preview: "gl",
      thumb: "img:lensFlare",
    },
    // ── Light Leak ──────────────────────────────────────────────────
    // Organic analog exposure burn: a warm blob spilling in from an edge
    // (or corner, or both sides), drifting in and out while the exposure
    // flickers. Baked radial field + envelope, screen-blended.
    {
      id: "lightLeak",
      kind: "effect",
      category: "light",
      name: "Light Leak",
      description:
        "Analog film burn — warm light spilling in from the frame edge with organic drift and exposure flicker.",
      params: [
        num("intensity", "Intensity", 70, 0, 100, 1, "%"),
        { key: "color", label: "Color", type: "color", def: 0xff5a1e, min: 0, max: 0xffffff, step: 1 },
        {
          key: "pattern",
          label: "Pattern",
          type: "enum",
          def: 0,
          options: ["Edge Sweep", "Corner Bloom", "Dual Sides"],
        },
        num("spread", "Spread", 0.75, 0.25, 1, 0.02),
        num("speed", "Drift speed", 0.18, 0.04, 0.8, 0.01, "Hz"),
        num("flicker", "Flicker", 0.35, 0, 0.6, 0.02),
      ],
      preview: "gl",
      thumb: "img:lightLeak",
    },
    // ── God Rays ────────────────────────────────────────────────────
    // Volumetric shafts from an off-frame source: an angular comb of rays
    // with a radial reach falloff, baked once and rotated slowly about the
    // source (sway). GPU/native cost stays low — one rotate of a half-res
    // sprite per frame.
    {
      id: "godRays",
      kind: "effect",
      category: "light",
      name: "God Rays",
      description:
        "Volumetric light shafts from a source point — adjustable fan, slow sway, gentle breathing.",
      params: [
        num("intensity", "Intensity", 55, 0, 100, 1, "%"),
        num("x", "Source X", 18, -20, 120, 1, "%"),
        num("y", "Source Y", -8, -20, 120, 1, "%"),
        { key: "angle", label: "Fan angle", type: "angle", def: 35, min: 0, max: 360, step: 5, unit: "°" },
        num("density", "Ray density", 14, 4, 30, 0.5),
        num("spread", "Ray softness", 0.7, 0.2, 1, 0.02),
        num("length", "Reach", 0.8, 0.3, 1.2, 0.02),
        num("speed", "Sway speed", 0.06, 0, 0.4, 0.01, "Hz"),
      ],
      preview: "gl",
      thumb: "img:godRays",
    },
    // ── Prism Refraction ────────────────────────────────────────────
    // Glass dispersion: the red and blue planes diverge radially around a
    // centre point (export scales/merges real channel planes), plus a slow
    // spectral glint sweeping the frame. Pattern picks the geometry.
    {
      id: "prismRefraction",
      kind: "effect",
      category: "light",
      name: "Prism Refraction",
      description:
        "Spectral dispersion — RGB planes split radially around a point while a rainbow glint sweeps the frame.",
      params: [
        num("intensity", "Intensity", 65, 0, 100, 1, "%"),
        num("amount", "Dispersion", 0.8, 0.1, 2, 0.05),
        num("x", "Centre X", 50, 0, 100, 1, "%"),
        num("y", "Centre Y", 45, 0, 100, 1, "%"),
        {
          key: "pattern",
          label: "Pattern",
          type: "enum",
          def: 0,
          options: ["Radial", "Edge Split", "Halo"],
        },
        num("glint", "Rainbow glint", 0.5, 0, 1, 0.02),
        num("speed", "Glint speed", 0.08, 0, 0.4, 0.01, "Hz"),
      ],
      preview: "gl",
      thumb: "img:prismRefraction",
    },
  ],
};

export function manifestJson(): string {
  return JSON.stringify(MANIFEST, null, 2) + "\n";
}

// CLI: `npm run fx:manifest` (node runs TS natively) writes manifest.json.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("shared/fx/build.ts")) {
  const { writeFileSync } = await import("node:fs");
  const out = new URL("./manifest.json", import.meta.url);
  writeFileSync(out, manifestJson());
  console.log("wrote", out.pathname);
}
