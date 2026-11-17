import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { filterGL, type FilterPass } from "@/lib/fx/gl-filter";
import { rasterizeLayer, type LayerInfo } from "@/lib/fx/layer-raster";

/**
 * Creative-filter preview layer (shared WebGL2 compositor).
 *
 * The clip's media element stays mounted underneath (decoding, seeking,
 * audio) but is hidden — exactly like TransitionLayer. Each draw
 * rasterises the layer (transform + CSS/SVG effect filters included) into
 * a project-space 2D canvas, runs the filter passes on the shared GL
 * context and blits the result into this layer's own canvas. The canvas
 * covers the whole stage so DOM order keeps the clip's z-position; where
 * the clip isn't, the GL output is transparent.
 *
 * Failure (no WebGL2, context lost) reports upward → the media element is
 * shown again unfiltered, never a black/empty frame.
 */

const MAX_W = 1280;

export function FilterLayer({
  clipId,
  passes,
  relMs,
  projectW,
  projectH,
  getLayer,
  onFail,
}: {
  clipId: string;
  passes: FilterPass[];
  relMs: number;
  projectW: number;
  projectH: number;
  getLayer: (clipId: string) => LayerInfo | null;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const src = useRef<HTMLCanvasElement | null>(null);
  src.current ??= document.createElement("canvas");

  // Paused seeks/decode: a render can land while readyState<2 (blank
  // raster). requestVideoFrameCallback only fires for PRESENTED frames —
  // while paused, seeked/loadeddata are what tell us a frame is usable.
  // The layer's element may not exist at mount (refs settle in the same
  // commit) or may be swapped later, so arm listeners when it appears and
  // keep a poll that bumps while the video has no decoded frame.
  const [, setFrame] = useState(0);
  useEffect(() => {
    let el: HTMLVideoElement | null = null;
    let h = 0;
    const bump = () => setFrame((n) => n + 1);
    const tick = () => {
      bump();
      if (el) h = el.requestVideoFrameCallback(tick);
    };
    const disarm = () => {
      if (!el) return;
      el.cancelVideoFrameCallback(h);
      for (const ev of ["seeked", "loadeddata", "canplay"]) el.removeEventListener(ev, bump);
      el = null;
    };
    const iv = window.setInterval(() => {
      const cur = getLayer(clipId)?.el;
      const vid = cur instanceof HTMLVideoElement ? cur : null;
      if (vid !== el) {
        disarm();
        el = vid;
        if (el) {
          for (const ev of ["seeked", "loadeddata", "canplay"]) el.addEventListener(ev, bump);
          h = el.requestVideoFrameCallback(tick);
        }
      }
      if (el && el.readyState < 2) bump();
    }, 200);
    return () => {
      window.clearInterval(iv);
      disarm();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  // Draw on every render (the playhead drives re-renders).
  const fails = useRef(0);
  useLayoutEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const rect = host.current?.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.min(MAX_W, Math.round((rect?.width || 640) * dpr)));
    const h = Math.max(2, Math.round((w * projectH) / projectW));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const layer = getLayer(clipId);
    // Element mid-remount (ref detach/attach) → keep the last frame
    // rather than blinking a blank canvas.
    if (!layer) return;
    rasterizeLayer(src.current!, layer, projectW, w, h);
    const out = filterGL().render(src.current!, passes, w, h, relMs / 1000);
    // A single bad frame must not permanently kill GL for the whole
    // preview — only sustained failure (≈1s of frames) escalates to the
    // unfiltered fallback. On a null render the canvas keeps its last
    // contents, so the drop is invisible.
    if (!out) {
      if (++fails.current >= 60) onFail();
      return;
    }
    fails.current = 0;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(out, 0, 0);
  });

  return (
    <div ref={host} className="pointer-events-none absolute inset-0">
      <canvas ref={cvRef} className="h-full w-full" />
    </div>
  );
}
