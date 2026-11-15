import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";

/**
 * Timeline filmstrip for a video clip — a `media.filmstrip` job renders
 * FRAMES evenly spaced source frames into a disk-cached tiled JPEG (one
 * ffmpeg pass). The clip draws one tile per visible cell, sampled across
 * its [sourceInMs, +durationMs) window — tile 0 is the clip's first
 * frame, so trims re-sample from the new edge. Undecodable sources
 * render nothing (the clip's plain tint remains).
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
    // Tiled thumbnails: one sprite cell per tile, sampled across the
    // clip's own [sourceIn,+duration) window — tile 0 is the clip's
    // first frame, so a trim re-samples from the new edge.
    const cellW = img.naturalWidth / FRAMES;
    const cellH = img.naturalHeight;
    const tileW = H * (cellW / cellH);
    const tiles = Math.max(1, Math.round(W / tileW));
    const stepMs = durationMs / tiles;
    for (let i = 0; i < tiles; i++) {
      const t = Math.min(
        sourceDurationMs - 1,
        sourceInMs + (i + 0.5) * stepMs,
      );
      const cell = Math.max(0, Math.min(FRAMES - 1, Math.floor((t / sourceDurationMs) * FRAMES)));
      const x0 = Math.round(i * tileW);
      g.drawImage(img, cell * cellW, 0, cellW, cellH, x0, 0, Math.round((i + 1) * tileW) - x0, H);
    }
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
