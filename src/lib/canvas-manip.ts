/** Canvas direct-manipulation math — pure helpers for tests. */

export interface SnapResult {
  x: number;
  y: number;
  vGuide: number | null; // canvas-space x of vertical guide
  hGuide: number | null;
}

/** Snap a moving point to canvas center axes within `tol` canvas px. */
export function snapToGuides(
  x: number,
  y: number,
  W: number,
  H: number,
  tol: number,
): SnapResult {
  const cx = W / 2;
  const cy = H / 2;
  const vGuide = Math.abs(x - cx) <= tol ? cx : null;
  const hGuide = Math.abs(y - cy) <= tol ? cy : null;
  return {
    x: vGuide !== null ? cx : x,
    y: hGuide !== null ? cy : y,
    vGuide,
    hGuide,
  };
}

/** Proportional resize from a corner drag: returns new uniform-ish scale
 *  factors preserving the current aspect (scales X and Y by the same
 *  dominant factor so FFmpeg's scaleX/scaleY stay consistent). */
export function scaleFromCorner(
  baseScaleX: number,
  baseScaleY: number,
  baseW: number,
  baseH: number,
  dx: number,
  dy: number,
): { scaleX: number; scaleY: number } {
  if (baseW <= 0 || baseH <= 0) return { scaleX: baseScaleX, scaleY: baseScaleY };
  const fx = 1 + dx / baseW;
  const fy = 1 + dy / baseH;
  const f = Math.max(0.05, Math.abs(fx) >= Math.abs(fy) ? fx : fy);
  return { scaleX: baseScaleX * f, scaleY: baseScaleY * f };
}

/** Rotation in degrees from a pointer position relative to element center. */
export function angleDeg(cx: number, cy: number, px: number, py: number): number {
  return (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
}
