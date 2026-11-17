/**
 * Dev-only probe (installed from main.tsx when `import.meta.env.DEV`).
 *
 * `window.__fxProbe(id, params, ease, u)` renders a library transition on
 * the REAL WebGL2 pipeline (same singleton, shader builder and texture
 * upload the preview uses) over deterministic synthetic layers, then runs
 * the CPU reference interpreter on the same pixels and reports how closely
 * they agree. Combined with the vitest suite (interpreter ≡ real ffmpeg
 * xfade) this closes the loop GL ≡ interpreter ≡ ffmpeg. Driven by
 * qa/cdp.py.
 */

import { evaluate, parse, toByte } from "./expr";
import { expandTemplate, fxEntry } from "./manifest";
import { transitionGL } from "./gl-transition";

function layer(w: number, h: number, kind: "a" | "b"): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const c = cv.getContext("2d")!;
  if (kind === "a") {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#0a3d91");
    g.addColorStop(0.5, "#e8a21b");
    g.addColorStop(1, "#c1272d");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#fff";
    c.fillRect(w * 0.1, h * 0.2, w * 0.25, h * 0.35);
    c.fillStyle = "#111";
    c.beginPath();
    c.arc(w * 0.7, h * 0.6, h * 0.25, 0, Math.PI * 2);
    c.fill();
  } else {
    const cols = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#ffffff", "#303030"];
    cols.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect((i * w) / cols.length, 0, w / cols.length + 1, h);
    });
    c.fillStyle = "#000";
    c.fillRect(0, h * 0.7, w, h * 0.3);
  }
  return cv;
}

export interface FxProbeResult {
  ok: boolean;
  status: string;
  psnr: number;
  maxDiff: number;
  /** fraction of channel samples differing by more than 2 levels */
  fracBad: number;
  glMs: number;
}

export function installFxProbe() {
  (window as unknown as Record<string, unknown>).__fxProbe = (
    id: string,
    params: Record<string, number> | undefined,
    ease: string | undefined,
    u: number,
    w = 160,
    h = 90,
  ): FxProbeResult => {
    const entry = fxEntry(id)!;
    const a = layer(w, h, "a");
    const b = layer(w, h, "b");
    const gl = transitionGL();
    const t0 = performance.now();
    const ok = gl.draw({ entry, ease, params, u, a, b, w, h });
    const px = ok ? gl.readPixels(w, h) : null;
    const glMs = performance.now() - t0;
    if (!px) return { ok: false, status: gl.status, psnr: 0, maxDiff: 255, fracBad: 1, glMs };

    const A = a.getContext("2d")!.getImageData(0, 0, w, h).data;
    const B = b.getContext("2d")!.getImageData(0, 0, w, h).data;
    const ast = parse(expandTemplate(entry, params, ease));
    const samp = (img: Uint8ClampedArray, ch: number) => (x: number, y: number) => {
      const cx = Math.min(w - 1, Math.max(0, Math.floor(x)));
      const cy = Math.min(h - 1, Math.max(0, Math.floor(y)));
      return img[(cy * w + cx) * 4 + ch];
    };
    let se = 0;
    let maxDiff = 0;
    let bad = 0;
    let n = 0;
    for (let ch = 0; ch < 3; ch++) {
      const sa = samp(A, ch);
      const sb = samp(B, ch);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const want = toByte(evaluate(ast, { vars: { X: x, Y: y, W: w, H: h, u, PLANE: ch }, sa, sb }));
          const got = px[(y * w + x) * 4 + ch];
          const d = Math.abs(got - want);
          se += d * d;
          maxDiff = Math.max(maxDiff, d);
          if (d > 2) bad++;
          n++;
        }
    }
    const mse = se / n;
    return {
      ok: true,
      status: gl.status,
      psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse),
      maxDiff,
      fracBad: bad / n,
      glMs,
    };
  };
}

/** Dev-only handle so QA scripts can drive the real stores/commands. */
export async function installQaHandle() {
  const [{ useProject }, { useEditor }, engine, { api }, jobs] = await Promise.all([
    import("@/stores/project"),
    import("@/stores/editor"),
    import("@/lib/timeline-engine"),
    import("@/lib/ipc"),
    import("@/services/jobs"),
  ]);
  (window as unknown as Record<string, unknown>).__qa = { useProject, useEditor, engine, api, jobs };
}
