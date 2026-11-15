import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";

/**
 * Timeline filmstrip for a video clip — a `media.filmstrip` job renders
 * FRAMES evenly spaced source frames into a disk-cached tiled JPEG (one
 * ffmpeg pass). The clip draws its [sourceInMs, +durationMs) slice of
 * the strip, so trims stay accurate. Undecodable sources render nothing
 * (the single-thumbnail layer stays behind as fallback).
 */

const FRAMES = 48;

const strips = new Map<string, Promise<HTMLImageElement | null>>();

function loadStrip(srcPath: string): Promise<HTMLImageElement | null> {
  let p = strips.get(srcPath);
  if (!p) {
    p = (async () => {
      try {
        let jpg = await api.readFilmstrip(srcPath, FRAMES);
        if (!jpg) {
          const jobId = await api.generateFilmstrip(srcPath, FRAMES);
          if (jobId) {
            await awaitJob(jobId);
            jpg = await api.readFilmstrip(srcPath, FRAMES);
          }
        }
        if (!jpg) return null;
        const img = new Image();
        img.src = convertFileSrc(jpg);
        await img.decode();
        return img;
      } catch {
        return null; // missing/undecodable source — filmstrip absent
      }
    })();
    strips.set(srcPath, p);
  }
  return p;
}

export function FilmstripCanvas({
  srcPath,
  sourceInMs,
  sourceDurationMs,
  durationMs,
  heightPx,
  widthPx,
}: {
  srcPath: string;
  sourceInMs: number;
  /** Full source-media duration — the strip covers [0, this). */
  sourceDurationMs: number;
  durationMs: number;
  heightPx: number;
  widthPx: number;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    loadStrip(srcPath).then((i) => {
      if (live) setImg(i);
    });
    return () => {
      live = false;
    };
  }, [srcPath]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !img || sourceDurationMs <= 0) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const W = cv.width;
    const H = cv.height;
    g.clearRect(0, 0, W, H);
    const sx = Math.max(0, (sourceInMs / sourceDurationMs) * img.naturalWidth);
    const sw = Math.min(
      img.naturalWidth - sx,
      (durationMs / sourceDurationMs) * img.naturalWidth,
    );
    if (sw <= 0) return;
    g.drawImage(img, sx, 0, sw, img.naturalHeight, 0, 0, W, H);
  }, [img, sourceInMs, sourceDurationMs, durationMs, widthPx, heightPx]);

  if (!img) return null;
  return (
    <canvas
      ref={canvasRef}
      // Backing store capped — the strip has FRAMES cells, so huge clips
      // (multi-minute sources) only need a few thousand px of resolution;
      // uncapped it would exceed the browser canvas limit and waste RAM.
      width={Math.max(2, Math.min(8192, Math.round(widthPx)))}
      height={Math.max(2, Math.round(heightPx))}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-60"
    />
  );
}
