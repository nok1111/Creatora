/**
 * Rasterise one preview layer (a clip's media with its transform, opacity
 * and CSS/SVG effect filters) into a 2D canvas. The WebGL transition reads
 * these canvases as textures, so the clips keep their effects and keyframed
 * transforms while a procedural transition runs — the same inputs the
 * export feeds its transition graph.
 */

export interface LayerInfo {
  el: HTMLVideoElement | HTMLImageElement;
  /** Placement in PROJECT canvas px (top-left + size), same as clipRect. */
  rect: { x: number; y: number; w: number; h: number };
  rotationDeg: number;
  /** Clip opacity WITHOUT the transition's own alpha. */
  opacity: number;
  /** CSS `filter` value (css functions + `url(#svg-filter)`). */
  filter: string;
}

// Videos: a seeking element keeps presenting its last decoded frame —
// drawImage still yields it, so HAVE_METADATA(1) is enough to draw.
// Before the first frame ever decodes, drawImage is a no-op either way.
// Requiring >=2 (HAVE_CURRENT_DATA) blanks the layer through every
// drift-correction seek — visible as the filter dropping out in playback.
const ready = (el: LayerInfo["el"]) =>
  el instanceof HTMLVideoElement ? el.readyState >= 1 : el.complete && el.naturalWidth > 0;

export function rasterizeLayer(
  cv: HTMLCanvasElement,
  layer: LayerInfo | null,
  projectW: number,
  w: number,
  h: number,
) {
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const ctx = cv.getContext("2d", { alpha: true })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.clearRect(0, 0, w, h);
  if (!layer || !ready(layer.el)) return;
  const k = w / projectW;
  const { x, y, w: rw, h: rh } = layer.rect;
  ctx.translate((x + rw / 2) * k, (y + rh / 2) * k);
  if (layer.rotationDeg) ctx.rotate((layer.rotationDeg * Math.PI) / 180);
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
  if (layer.filter) ctx.filter = layer.filter;
  ctx.drawImage(layer.el, (-rw / 2) * k, (-rh / 2) * k, rw * k, rh * k);
}
