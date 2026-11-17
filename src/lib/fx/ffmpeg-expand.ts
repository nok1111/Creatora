/**
 * Recipe → the literal expression handed to `xfade=transition=custom`
 * (test oracle / dev tooling only — the export uses native graphs).
 *
 * ffmpeg's `a0..a3(x,y)` / `b0..b3(x,y)` read a FIXED plane, so the
 * `SA(x,y)` / `SB(x,y)` macros expand to a dispatch on `PLANE` (the plane
 * being written). Rust (render/fxlib.rs) implements the same expansion;
 * `shared/fx/golden.json` pins both to identical output.
 *
 * Used by tests and dev tooling — the app itself never runs this (the
 * render side lives in Rust).
 */

import { expandTemplate, type FxEntry } from "./manifest.ts";

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function expandSamplers(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const m = /^S([AB])\(/.exec(expr.slice(i));
    // Only a macro when it starts an identifier (not e.g. `XSA(`).
    if (m && (i === 0 || !/\w/.test(expr[i - 1]))) {
      const start = i + m[0].length;
      let depth = 1;
      let j = start;
      while (j < expr.length && depth > 0) {
        if (expr[j] === "(") depth++;
        else if (expr[j] === ")") depth--;
        j++;
      }
      if (depth !== 0) throw new Error("unbalanced SA/SB call");
      const [x, y] = splitArgs(expr.slice(start, j - 1)).map(expandSamplers);
      const p = m[1].toLowerCase();
      out += `if(eq(PLANE,0),${p}0(${x},${y}),if(eq(PLANE,1),${p}1(${x},${y}),if(eq(PLANE,2),${p}2(${x},${y}),${p}3(${x},${y}))))`;
      i = j;
    } else {
      out += expr[i++];
    }
  }
  return out;
}

export function ffmpegExpr(
  e: FxEntry,
  params: Record<string, number> | undefined,
  ease?: string,
): string {
  // xfade's progress P runs 1→0; the recipe's linear progress is u = 1-P.
  return expandSamplers(expandTemplate(e, params, ease, "1-P"));
}
