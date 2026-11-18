/**
 * Bleach Bypass tuning probe — prints the luma ramp + skin samples for the
 * shipped v1 recipe and candidates, then renders ONE labeled comparison
 * sheet through real ffmpeg lut3d (same sample, same exposure, int. 80):
 *   qa/out/bb_candidates.png   (Original | v1 | candidates)
 *
 *   npx tsx qa/fx_lut_probe.ts
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fxEntry } from "../src/lib/fx/manifest.ts";
import { applyLut, bakeCubeText } from "../src/lib/fx/lut.ts";
import type { LutOp } from "../shared/fx/build.ts";

const base = fxEntry("bleachBypass");
if (!base) throw new Error("bleachBypass missing");

// The recipe as shipped BEFORE the v2 midtone fix (kept for A/B sheets —
// the manifest now holds v2, so don't read `base.lut` here).
const shippedV1: LutOp[] = [
  { op: "temp", amt: -0.1 },
  { op: "curve", ch: 3, pts: [[0, 0], [0.2, 0.11], [0.5, 0.48], [0.8, 0.88], [1, 1]] },
  { op: "split", sh: [215, 0.12], hi: [222, 0.09] },
  { op: "sat", amt: 0.42 },
  { op: "vib", amt: 0.85 },
  { op: "hsl", hue: 28, range: 40, dh: 0, ds: 1.25, dl: 0 },
  { op: "hsl", hue: 200, range: 70, dh: -5, ds: 0.82, dl: 0 },
  { op: "hsl", hue: 95, range: 55, dh: -10, ds: 0.75, dl: -0.02 },
];

const mk = (pts: [number, number][], dl: number, range = 42): LutOp[] => [
  { op: "temp", amt: -0.1 },
  { op: "curve", ch: 3, pts },
  { op: "split", sh: [215, 0.12], hi: [222, 0.09] },
  { op: "sat", amt: 0.42 },
  { op: "vib", amt: 0.85 },
  { op: "hsl", hue: 28, range, dh: 0, ds: 1.25, dl },
  { op: "hsl", hue: 200, range: 70, dh: -5, ds: 0.82, dl: 0 },
  { op: "hsl", hue: 95, range: 55, dh: -10, ds: 0.75, dl: -0.02 },
];

const cands: Record<string, LutOp[]> = {
  // C: moderate mid lift, small skin dl (achromatic floor ≈ dl·0.64)
  candC: mk([[0, 0], [0.1, 0.04], [0.25, 0.2], [0.5, 0.51], [0.8, 0.88], [1, 1]], 0.03),
  // D: stronger face band (rejected — user picked E)
  candD: mk([[0, 0], [0.1, 0.04], [0.25, 0.22], [0.5, 0.53], [0.8, 0.88], [1, 1]], 0.04),
  // E: SHIPPED as v2 — like D but toe pushed deeper to keep blacks despite dl
  candE: mk([[0, 0], [0.08, 0.028], [0.2, 0.16], [0.45, 0.45], [0.65, 0.72], [0.85, 0.92], [1, 1]], 0.04),
};

const variants: [string, LutOp[]][] = [
  ["v1 (before)", shippedV1],
  ...Object.entries(cands).map(([k, v]) => [k === "candE" ? "candE = shipped" : k, v] as [string, LutOp[]]),
];

const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const ramp = (ops: LutOp[]) =>
  Array.from({ length: 21 }, (_, i) => {
    const v = i / 20;
    const o = applyLut([v, v, v], ops, {});
    return `${v.toFixed(2)}→${luma(o).toFixed(3)}`;
  }).join("  ");

console.log("gray ramp (in → luma out)");
for (const [n, ops] of variants) console.log(`${n}:`, ramp(ops));

const skin: [number, number, number][] = [
  [0.3, 0.2, 0.13],
  [0.45, 0.33, 0.24],
  [0.2, 0.14, 0.1],
];
for (const s of skin) {
  const line = variants.map(([, ops]) => luma(applyLut([...s] as any, ops, {})).toFixed(3));
  console.log(`skin ${s.join(",")} luma:`, variants.map(([n], i) => `${n}=${line[i]}`).join("  "));
}

// ── comparison sheet (one file, real ffmpeg lut3d, intensity 80) ──────
const TMP = "qa/out/.bb_tmp";
mkdirSync(TMP, { recursive: true });
variants.forEach(([name, ops], i) =>
  writeFileSync(`${TMP}/v${i}.cube`, bakeCubeText({ ...base, lut: ops } as any, { intensity: 80 })));

const tiles = ["Original", ...variants.map(([n]) => n)];
while (tiles.length % 2) tiles.push("");
const fc: string[] = [`[0:v]split=${tiles.length}${tiles.map((_, i) => `[s${i}]`).join("")}`];
const font = "fontfile='C\\:/Windows/Fonts/arial.ttf'";
tiles.forEach((label, i) => {
  const grade = i === 0 ? "" : i <= variants.length ? `lut3d='${TMP}/v${i - 1}.cube',` : "drawbox=c=0x1e1e1e:t=fill,";
  fc.push(
    `[s${i}]${grade}scale=496:160,pad=512:200:8:6:0x1e1e1e,` +
    `drawtext=${font}:text='${label || " "}':fontcolor=white:fontsize=15:x=8:y=176[t${i}]`,
  );
});
const layout = tiles.map((_, i) => `${(i % 2) * 512}_${Math.floor(i / 2) * 200}`).join("|");
fc.push(`${tiles.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${tiles.length}:layout=${layout}[out]`);

const ff = "src-tauri/target/debug/tools/bin/ffmpeg.exe";
const r = spawnSync(ff, ["-hide_banner", "-v", "error", "-y", "-i", "shared/fx/sample.png",
  "-filter_complex", fc.join(";"), "-map", "[out]", "-frames:v", "1",
  `qa/out/bb_candidates.png`], { encoding: "utf8" });
rmSync(TMP, { recursive: true, force: true });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log(`wrote qa/out/bb_candidates.png (${tiles.length} tiles)`);
