/**
 * Format preset catalog — SINGLE source of truth for canvas dimensions and
 * platform recommendations (ADR-022). Never hardcode WxH elsewhere; extend
 * by adding entries here.
 *
 * `platform` is a *recommendation hint*, not a compatibility guarantee —
 * publishing requirements change; the export settings carry what we render.
 */
import type { Canvas, SafeZones } from "@/lib/project-types";

export interface FormatPreset {
  /** Stable id persisted on the version (metadata only). */
  id: string;
  label: string;
  /** Platform hint for grouping in the UI. */
  platform?: string;
  canvas: Omit<Canvas, "fpsNum" | "fpsDen" | "background">;
  /** Suggested safe-area margins (canvas fractions) for platform chrome. */
  safeZones: SafeZones;
  /** Suggested duration cap in ms — 0 = none. Display only. */
  maxDurationMs?: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  {
    id: "yt-16x9-1080",
    label: "YouTube · Horizontal 16:9",
    platform: "YouTube",
    canvas: { width: 1920, height: 1080 },
    safeZones: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  {
    id: "shorts-9x16-1080",
    label: "Shorts · Vertical 9:16",
    platform: "YouTube",
    canvas: { width: 1080, height: 1920 },
    safeZones: { top: 0.08, bottom: 0.22, left: 0.04, right: 0.04 },
    maxDurationMs: 60_000,
  },
  {
    id: "tiktok-9x16-1080",
    label: "TikTok · Vertical 9:16",
    platform: "TikTok",
    canvas: { width: 1080, height: 1920 },
    safeZones: { top: 0.1, bottom: 0.24, left: 0.05, right: 0.15 },
  },
  {
    id: "ig-reels-9x16-1080",
    label: "Reels · Vertical 9:16",
    platform: "Instagram",
    canvas: { width: 1080, height: 1920 },
    safeZones: { top: 0.1, bottom: 0.26, left: 0.05, right: 0.16 },
    maxDurationMs: 90_000,
  },
  {
    id: "ig-feed-4x5-1080",
    label: "Instagram Post · 4:5",
    platform: "Instagram",
    canvas: { width: 1080, height: 1350 },
    safeZones: { top: 0.05, bottom: 0.05, left: 0.03, right: 0.03 },
  },
  {
    id: "square-1x1-1080",
    label: "Square 1:1 · 1080p",
    platform: "Instagram",
    canvas: { width: 1080, height: 1080 },
    safeZones: { top: 0.05, bottom: 0.05, left: 0.03, right: 0.03 },
  },
  {
    id: "fb-16x9-1080",
    label: "Facebook 16:9 · 1080p",
    platform: "Facebook",
    canvas: { width: 1920, height: 1080 },
    safeZones: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  {
    id: "fb-9x16-1080",
    label: "Facebook Vertical 9:16 · 1080p",
    platform: "Facebook",
    canvas: { width: 1080, height: 1920 },
    safeZones: { top: 0.08, bottom: 0.2, left: 0.04, right: 0.04 },
  },
  // Generic aspect ratios — no platform claimed.
  { id: "ar-16x9", label: "16:9 Landscape · 1920×1080", canvas: { width: 1920, height: 1080 }, safeZones: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: "ar-9x16", label: "9:16 Portrait · 1080×1920", canvas: { width: 1080, height: 1920 }, safeZones: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: "ar-4x5", label: "4:5 Portrait · 1080×1350", canvas: { width: 1080, height: 1350 }, safeZones: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: "ar-1x1", label: "1:1 Square · 1080×1080", canvas: { width: 1080, height: 1080 }, safeZones: { top: 0, bottom: 0, left: 0, right: 0 } },
];

export function presetById(id: string): FormatPreset | undefined {
  return FORMAT_PRESETS.find((p) => p.id === id);
}

/** Cover-fit scale to fill `target` canvas from a `W×H` source. */
export function coverScale(srcW: number, srcH: number, dstW: number, dstH: number): number {
  return Math.max(dstW / srcW, dstH / srcH);
}

/**
 * Cover-fit reframe in *transform terms* (matches clipRect/`video_chain`
 * math exactly): the render fits-inside first, so the override scale is
 * cover/fit, and x/y is the offset from the centered position that puts
 * (focusX, focusY) — normalized source coords — at canvas center,
 * clamped so the cover window never leaves gaps.
 */
export function defaultReframe(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  focusX = 0.5,
  focusY = 0.5,
): { x: number; y: number; scale: number } {
  const fit = Math.min(dstW / srcW, dstH / srcH);
  const scale = coverScale(srcW, srcH, dstW, dstH) / fit;
  const w = srcW * fit * scale; // = srcW * cover
  const h = srcH * fit * scale;
  // Offset that lands the focus point on canvas center (see clipRect).
  const clampX = Math.max(0, (w - dstW) / 2);
  const clampY = Math.max(0, (h - dstH) / 2);
  const x = Math.min(clampX, Math.max(-clampX, w * (0.5 - focusX)));
  const y = Math.min(clampY, Math.max(-clampY, h * (0.5 - focusY)));
  return { x, y, scale };
}
