import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { transitionGL } from "@/lib/fx/gl-transition";
import { rasterizeLayer, type LayerInfo } from "@/lib/fx/layer-raster";
import type { ActiveLibTransition } from "@/lib/fx/active-transitions";

/**
 * Procedural-transition layer of the preview (WebGL2).
 *
 * Mounted ONLY while a library transition is inside its overlap window.
 * Each render rasterises the outgoing/incoming clips (transform, opacity and
 * effect filters included) into two 2D canvases and runs the manifest recipe
 * on the shared GL context. Unmounting releases the GPU objects; a failed
 * draw (no WebGL2, context lost, shader error) reports upward so the
 * preview keeps its DOM crossfade instead.
 */

const MAX_W = 1280;

export function TransitionLayer({
  active,
  projectW,
  projectH,
  getLayer,
  onFail,
}: {
  active: ActiveLibTransition;
  projectW: number;
  projectH: number;
  getLayer: (clipId: string) => LayerInfo | null;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const layers = useRef<[HTMLCanvasElement, HTMLCanvasElement] | null>(null);
  layers.current ??= [document.createElement("canvas"), document.createElement("canvas")];

  // A paused seek changes the video frame without changing React state:
  // redraw whenever either source presents a new frame.
  const [, setFrame] = useState(0);
  const idA = active.a.id;
  const idB = active.b.id;
  useEffect(() => {
    const cancels: (() => void)[] = [];
    for (const id of [idA, idB]) {
      const el = getLayer(id)?.el;
      if (!(el instanceof HTMLVideoElement) || !el.requestVideoFrameCallback) continue;
      let h = 0;
      const tick = () => {
        setFrame((n) => n + 1);
        h = el.requestVideoFrameCallback(tick);
      };
      h = el.requestVideoFrameCallback(tick);
      cancels.push(() => el.cancelVideoFrameCallback(h));
    }
    return () => cancels.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idA, idB]);

  // Attach the shared GL canvas BEFORE the first draw (a detached canvas'
  // drawing buffer is discarded); release GPU objects when we go away.
  useLayoutEffect(() => {
    const gl = transitionGL();
    const el = host.current!;
    const cv = gl.canvas;
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    el.appendChild(cv);
    return () => {
      cv.remove();
      gl.release();
    };
  }, []);

  // Draw on every render (the playhead drives re-renders). A single bad
  // frame must not permanently kill GL for the preview — only sustained
  // failure escalates to the DOM-crossfade fallback.
  const fails = useRef(0);
  useLayoutEffect(() => {
    // Re-attach the shared canvas if it drifted: dispose() swaps
    // `gl.canvas` for a fresh element, and an idle dispose can fire while
    // this layer is still mounted — leaving the DOM holding an orphaned
    // canvas while draw() paints into a detached one (black preview).
    const glc = transitionGL();
    if (glc.canvas.parentElement !== host.current) {
      glc.canvas.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
      host.current?.appendChild(glc.canvas);
    }
    const rect = host.current?.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.min(MAX_W, Math.round((rect?.width || 640) * dpr)));
    const h = Math.max(2, Math.round((w * projectH) / projectW));
    const [ca, cb] = layers.current!;
    rasterizeLayer(ca, getLayer(active.a.id), projectW, w, h);
    rasterizeLayer(cb, getLayer(active.b.id), projectW, w, h);
    const ok = transitionGL().draw({
      entry: active.entry,
      ease: active.tr.ease ?? active.entry.defaultEase,
      params: active.tr.params,
      u: active.u,
      a: ca,
      b: cb,
      w,
      h,
    });
    fails.current = ok ? 0 : fails.current + 1;
    if (fails.current >= 60) onFail();
  });

  return <div ref={host} className="pointer-events-none absolute inset-0" />;
}
