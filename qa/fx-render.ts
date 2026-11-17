/**
 * Dev tool: render a contact sheet of a transition recipe through REAL
 * ffmpeg (same expression the exporter uses).
 *
 *   node qa/fx-render.ts <entryId> [out.png] [key=val ...] [ease=easeInOut]
 *                       [size=WxH] [a=path.png] [b=path.png]
 *
 * Frames are sampled at progress 0.1 .. 0.9 and tiled left→right.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fxEntry } from "../src/lib/fx/manifest.ts";
import { ffmpegExpr } from "../src/lib/fx/ffmpeg-expand.ts";

const [id, outArg, ...kv] = process.argv.slice(2);
const e = fxEntry(id);
if (!e) throw new Error(`unknown entry ${id}`);
const params: Record<string, number> = {};
const opt: Record<string, string> = {};
for (const a of kv) {
  const [k, v] = a.split("=");
  if (["ease", "size", "a", "b"].includes(k)) opt[k] = v;
  else params[k] = Number(v);
}
const [w, h] = (opt.size ?? "480x270").split("x").map(Number);
const ff = "src-tauri/target/debug/tools/bin/ffmpeg.exe";
const fps = 30;
const dur = 1;
const lead = 0.5;
const src = (path: string | undefined, fallback: string) =>
  path && existsSync(path)
    ? ["-loop", "1", "-framerate", String(fps), "-t", "3", "-i", path]
    : ["-f", "lavfi", "-i", fallback];
const expr = ffmpegExpr(e, params, opt.ease);
const picks = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => Math.round((lead + p * dur) * fps));
const sel = picks.map((n) => `eq(n\\,${n})`).join("+");
const fc =
  `[0:v]scale=${w}:${h},setsar=1,format=gbrap[a];[1:v]scale=${w}:${h},setsar=1,format=gbrap[b];` +
  `[a][b]xfade=transition=custom:duration=${dur}:offset=${lead}:expr='${expr}',format=rgb24,select='${sel}',tile=5x1`;
const out = outArg ?? `qa/fx_${id}.png`;
const t0 = Date.now();
const r = spawnSync(
  ff,
  ["-v", "error", "-y",
    ...src(opt.a, `testsrc2=size=${w}x${h}:rate=${fps}:duration=3`),
    ...src(opt.b, `smptebars=size=${w}x${h}:rate=${fps}:duration=3`),
    "-filter_complex", fc, "-frames:v", "1", out],
  { encoding: "utf8" },
);
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}
console.log(`${id} → ${out}  (${Date.now() - t0} ms, expr ${expr.length} chars)`);
