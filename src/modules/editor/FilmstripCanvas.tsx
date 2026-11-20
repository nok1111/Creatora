import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";

/**
 * Timeline filmstrip for a video clip — a `media.filmstrip` job renders
 * FRAMES evenly spaced source frames into a disk-cached tiled JPEG (one
 * ffmpeg pass). The clip tiles it as a CSS background at real cell size,
 * offset so the first tile is the frame at sourceInMs — trimming shifts
 * the strip to the clip's new start frame. No canvas, so there is no
 * backing-store size limit on very long clips.
 */

const FRAMES = 48;

interface Strip {
  url: string;
  cellAspect: number;
}

const strips = new Map<string, Promise<Strip | null>>();

function loadStrip(srcPath: string): Promise<Strip | null> {
  if (!srcPath) return Promise.resolve(null);
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
        return {
          url: convertFileSrc(jpg),
          cellAspect: img.naturalWidth / FRAMES / img.naturalHeight,
        };
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
  heightPx,
}: {
  srcPath: string;
  sourceInMs: number;
  /** Full source-media duration — the strip covers [0, this). */
  sourceDurationMs: number;
  heightPx: number;
}) {
  const [strip, setStrip] = useState<Strip | null>(null);

  useEffect(() => {
    let live = true;
    loadStrip(srcPath).then((s) => {
      if (live) setStrip(s);
    });
    return () => {
      live = false;
    };
  }, [srcPath]);

  if (!strip || sourceDurationMs <= 0) return null;
  const cellW = heightPx * strip.cellAspect;
  const stripW = cellW * FRAMES;
  const offset = (sourceInMs / sourceDurationMs) * stripW;
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-60"
      style={{
        backgroundImage: `url("${strip.url}")`,
        backgroundSize: `${stripW}px 100%`,
        backgroundRepeat: "repeat-x",
        backgroundPositionX: `${-offset}px`,
      }}
    />
  );
}
