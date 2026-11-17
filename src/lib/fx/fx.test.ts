/**
 * FX library tests: manifest integrity, TS↔Rust golden pins, validation,
 * and — against REAL ffmpeg — proof that the recipe dialect semantics the
 * GLSL preview and CPU interpreter implement match `xfade=custom`.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST, manifestJson } from "../../../shared/fx/build";
import {
  FX_MANIFEST,
  defaultParams,
  expandTemplate,
  expandText,
  fxEntries,
  fxEntry,
  missingCapabilities,
  resolveConstants,
  validateParams,
} from "./manifest";
import { ffmpegExpr } from "./ffmpeg-expand";
import { bakeCubeText, bakeLutData } from "./lut";
import { evaluate, parse, toByte } from "./expr";
import { buildFragmentShader } from "./gl-shader";

const GOLDEN = join(process.cwd(), "shared/fx/golden.json");
const FF = join(process.cwd(), "src-tauri/target/debug/tools/bin/ffmpeg.exe");
const hasFfmpeg = existsSync(FF);

/** Every text the Rust side must reproduce byte-for-byte. */
function goldenTexts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fxEntries()) {
    if (e.expr) out[`${e.id}.expr`] = expandTemplate(e, undefined, undefined, "u");
    if (e.render?.kind === "fields")
      for (const [k, v] of Object.entries(e.render.fields))
        out[`${e.id}.field.${k}`] = expandText(e, v, undefined, undefined, "(N+0.5)/NT");
  }
  // Non-default params / ease exercise derive + number formatting.
  const sw = fxEntry("velocitySwipe")!;
  out["velocitySwipe.expr.down"] = expandTemplate(sw, { direction: 3, blur: 0.25 }, "easeOut", "u");
  return out;
}

describe("fx manifest", () => {
  it("checked-in manifest.json matches shared/fx/build.ts (run `npm run fx:manifest`)", () => {
    const onDisk = readFileSync(join(process.cwd(), "shared/fx/manifest.json"), "utf8");
    expect(onDisk).toBe(manifestJson());
    expect(FX_MANIFEST.entries.length).toBe(MANIFEST.entries.length);
  });

  it("ids are unique and every param has a sane spec", () => {
    const ids = fxEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of fxEntries()) {
      for (const p of e.params) {
        if (p.type === "enum") expect(p.options?.length, `${e.id}.${p.key}`).toBeGreaterThan(1);
        else if (p.type !== "bool") {
          expect(p.min, `${e.id}.${p.key}.min`).toBeDefined();
          expect(p.max).toBeGreaterThan(p.min!);
          expect(p.def).toBeGreaterThanOrEqual(p.min!);
          expect(p.def).toBeLessThanOrEqual(p.max!);
        }
      }
    }
  });

  it("golden expansions match shared/fx/golden.json (Rust pins the same file)", () => {
    const texts = goldenTexts();
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(texts, null, 2) + "\n");
    expect(JSON.parse(readFileSync(GOLDEN, "utf8"))).toEqual(texts);
  });

  it("every recipe parses, has no unresolved placeholders, and transpiles to GLSL", () => {
    for (const e of fxEntries().filter((x) => x.expr)) {
      const text = expandTemplate(e, undefined);
      expect(text, e.id).not.toMatch(/[{}]/);
      expect(() => parse(text), e.id).not.toThrow();
      const { source, uniforms } = buildFragmentShader(e);
      expect(source).toContain("float recipe()");
      expect(source).not.toMatch(/[{}]\w+[{}]/);
      for (const p of e.params) expect(uniforms.length >= 0 && p.key).toBeTruthy();
    }
  });

  it("transition entries declare a native render strategy", () => {
    for (const e of fxEntries().filter((x) => x.kind === "transition")) {
      expect(e.render, `${e.id} has no native render`).toBeDefined();
      expect(e.preview).toBe("gl");
    }
  });
});

describe("param validation", () => {
  const sw = fxEntry("velocitySwipe")!;
  it("clamps, drops unknowns, fills defaults, reports corrections", () => {
    const r = validateParams(sw, { blur: 9, direction: 7.4, bogus: 1 });
    expect(r.params).toEqual({ direction: 3, blur: 0.4 });
    expect(r.warnings.join("|")).toMatch(/blur/);
    expect(r.warnings.join("|")).toMatch(/bogus/);
    expect(validateParams(sw, undefined).params).toEqual(defaultParams(sw));
    expect(validateParams(sw, { blur: NaN }).params.blur).toBe(0.16);
  });
  it("derives constants from enums", () => {
    expect(resolveConstants(sw, { direction: 1 })).toMatchObject({ dx: 1, dy: 0 });
    expect(resolveConstants(sw, { direction: 3 })).toMatchObject({ dx: 0, dy: 1 });
  });
  it("capability gating", () => {
    expect(missingCapabilities(fxEntry("beatImpact")!)).toEqual([]);
    expect(missingCapabilities({ ...fxEntry("beatImpact")!, requires: ["subjectMask"] })).toEqual([
      "subjectMask",
    ]);
  });
});

// ── dialect vs real ffmpeg ─────────────────────────────────────────────

const W = 96;
const H = 54;
const dir = join(tmpdir(), `creatora_fx_${process.pid}`);

function ff(args: string[]): Buffer {
  const r = spawnSync(FF, ["-v", "error", "-y", ...args], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}

function makePng(name: string, lavfi: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  ff(["-f", "lavfi", "-i", lavfi, "-frames:v", "1", "-pix_fmt", "rgb24", p]);
  return p;
}

const readRgb = (png: string): Uint8Array =>
  new Uint8Array(ff(["-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]));

describe.skipIf(!hasFfmpeg)("recipe dialect ≡ ffmpeg xfade=custom", () => {
  const pa = makePng("a.png", `testsrc2=size=${W}x${H}:rate=1`);
  const pb = makePng("b.png", `smptebars=size=${W}x${H}:rate=1`);
  const A = readRgb(pa);
  const B = readRgb(pb);

  /** CPU interpreter result (per channel, like the GL preview). */
  function reference(id: string, params: Record<string, number> | undefined, ease: string, u: number) {
    const e = fxEntry(id)!;
    const ast = parse(expandTemplate(e, params, ease));
    const out = new Uint8Array(W * H * 3);
    const samp = (img: Uint8Array, ch: number) => (x: number, y: number) => {
      const cx = Math.min(W - 1, Math.max(0, Math.floor(x)));
      const cy = Math.min(H - 1, Math.max(0, Math.floor(y)));
      return img[(cy * W + cx) * 3 + ch];
    };
    for (let ch = 0; ch < 3; ch++) {
      const sa = samp(A, ch);
      const sb = samp(B, ch);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          out[(y * W + x) * 3 + ch] = toByte(
            evaluate(ast, { vars: { X: x, Y: y, W, H, u, PLANE: ch }, sa, sb }),
          );
    }
    return out;
  }

  /** Real ffmpeg: spec through xfade custom, frame n ⇒ u = n/30. */
  function viaFfmpeg(id: string, params: Record<string, number> | undefined, ease: string, n: number) {
    const e = fxEntry(id)!;
    const expr = ffmpegExpr(e, params, ease);
    const fc =
      `[0:v]format=gbrap[a];[1:v]format=gbrap[b];` +
      `[a][b]xfade=transition=custom:duration=1:offset=0:expr='${expr}',format=rgb24,select=eq(n\\,${n})`;
    const buf = ff([
      "-loop", "1", "-framerate", "30", "-t", "2", "-i", pa,
      "-loop", "1", "-framerate", "30", "-t", "2", "-i", pb,
      "-filter_complex", fc, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    return new Uint8Array(buf);
  }

  const cases: [string, Record<string, number> | undefined, string][] = [
    ["velocitySwipe", undefined, "easeInOut"],
    ["velocitySwipe", { direction: 3, blur: 0.3 }, "linear"],
    ["velocitySwipe", { direction: 1 }, "easeInOutCubic"],
    ["liquidMelt", undefined, "easeInOut"],
    ["liquidMelt", { drip: 1, wave: 0.1, freq: 6, wobble: 1 }, "easeOut"],
  ];

  for (const [id, params, ease] of cases) {
    it(`${id} ${JSON.stringify(params ?? {})} @${ease}`, () => {
      for (const n of [6, 15, 24]) {
        const got = viaFfmpeg(id, params, ease, n);
        const want = reference(id, params, ease, n / 30);
        let big = 0;
        let maxd = 0;
        for (let i = 0; i < got.length; i++) {
          const d = Math.abs(got[i] - want[i]);
          maxd = Math.max(maxd, d);
          if (d > 2) big++;
        }
        // float32/double + truncation noise only: ≤0.3% of samples may exceed ±2.
        expect(big / got.length, `${id} n=${n} maxΔ=${maxd}`).toBeLessThan(0.003);
      }
    }, 60000);
  }
});

// ── curves pinned against Rust (render/fxeffects.rs) ───────────────────
import {
  beatEnv,
  beatTimes,
  expoDecay,
  heroFlash,
  heroScale,
  heroSplitPx,
  rgbEnv,
  rgbShift,
} from "./envelopes";

describe("library effect curves", () => {
  const CURVES = join(process.cwd(), "shared/fx/curves.golden.json");
  function table() {
    const ts = [0, 0.05, 0.2, 0.37, 0.9, 1.4];
    const out: Record<string, number | number[]> = {};
    for (const t of ts) {
      out[`expo@${t}`] = expoDecay(t);
      for (const m of [0, 1, 2]) out[`rgbEnv${m}@${t}`] = rgbEnv(m, 3, t);
      out[`shift@${t}`] = rgbShift(1.2, 35, rgbEnv(2, 3, t), 1920);
      out[`heroScale@${t}`] = heroScale(0.22, 0.9, t);
      out[`heroFlash@${t}`] = heroFlash(0.5, 0.9, t);
      out[`heroSplit@${t}`] = heroSplitPx(1, 1920, 0.9, t);
    }
    const beats = beatTimes([1000, 1500, 2100, 3000], 1, 50, { sourceInMs: 500, speed: 1, clipMs: 10000 });
    out["beats"] = beats;
    for (const t of ts) out[`beatEnv@${t}`] = beatEnv(beats, 8, t + 0.5);
    return out;
  }
  it("matches shared/fx/curves.golden.json (Rust pins the same file)", () => {
    const t = table();
    if (process.env.UPDATE_GOLDEN) writeFileSync(CURVES, JSON.stringify(t, null, 2) + "\n");
    expect(JSON.parse(readFileSync(CURVES, "utf8"))).toEqual(JSON.parse(JSON.stringify(t)));
  });
  it("endpoints are exact", () => {
    expect(expoDecay(0)).toBe(1);
    expect(expoDecay(1)).toBeCloseTo(0, 12);
    expect(heroScale(0.3, 1, 5)).toBe(1);
  });
});

describe("filter LUT baking", () => {
  const LUT_GOLDEN = join(process.cwd(), "shared/fx/lut-golden.json");
  const GRID = [0, 8, 16, 24, 32];

  function table() {
    const out: Record<string, Record<string, number[]>> = {};
    for (const e of fxEntries()) {
      if (e.kind !== "filter") continue;
      const consts = resolveConstants(e, undefined);
      const intensity = (consts.intensity ?? 100) / 100;
      const data = bakeLutData(e.lut, consts, intensity);
      const nodes: Record<string, number[]> = {};
      for (const b of GRID)
        for (const g of GRID)
          for (const r of GRID) {
            const idx = (b * 33 + g) * 33 + r;
            nodes[`${r},${g},${b}`] = [data[idx * 3], data[idx * 3 + 1], data[idx * 3 + 2]];
          }
      out[e.id] = nodes;
    }
    return out;
  }

  it("matches shared/fx/lut-golden.json (Rust pins the same file)", () => {
    const t = table();
    if (process.env.UPDATE_GOLDEN) writeFileSync(LUT_GOLDEN, JSON.stringify(t) + "\n");
    expect(JSON.parse(readFileSync(LUT_GOLDEN, "utf8"))).toEqual(JSON.parse(JSON.stringify(t)));
  });

  it("intensity 0 is the identity transform", () => {
    const e = fxEntries().find((x) => x.kind === "filter")!;
    const data = bakeLutData(e.lut, resolveConstants(e, undefined), 0);
    for (const [r, g, b] of [[0, 0, 0], [16, 24, 8], [32, 32, 32]]) {
      const idx = ((b * 33 + g) * 33 + r) * 3;
      expect(data[idx]).toBeCloseTo(r / 32, 6);
      expect(data[idx + 1]).toBeCloseTo(g / 32, 6);
      expect(data[idx + 2]).toBeCloseTo(b / 32, 6);
    }
  });

  it(".cube text has the header + 33³ lines in 0..1", () => {
    const e = fxEntries().find((x) => x.kind === "filter")!;
    const text = bakeCubeText(e, undefined);
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("LUT_3D_SIZE 33");
    expect(lines.length).toBe(1 + 1 + 33 * 33 * 33); // header + comment + nodes
    for (const i of [2, 100, 18000, lines.length - 1])
      for (const v of lines[i].split(" ").map(Number)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
  });
});
