import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Timeline filmstrip for a video clip — real frames sampled across the
 * source, decoded by a hidden <video> element and cached per source path
 * as one sprite strip. The clip draws its [sourceInMs, +durationMs)
 * slice, so trims and zoom stay accurate. Sources the WebView can't
 * decode simply render nothing (the single-thumbnail layer stays behind).
 */

interface Sprite {
  strip: HTMLCanvasElement;
  srcDurMs: number;
}

const sprites = new Map<string, Promise<Sprite | null>>();
const FRAME_H = 72;
const MAX_FRAMES = 96;

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 3000);
    function done() {
      clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    }
    v.addEventListener("seeked", done);
    v.currentTime = t;
  });
}

async function buildSprite(srcPath: string): Promise<Sprite | null> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = convertFileSrc(srcPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("metadata timeout")), 10_000);
      v.addEventListener("loadedmetadata", () => {
        clearTimeout(timer);
        resolve();
      });
      v.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("video decode failed"));
      });
    });
    const srcDurMs = v.duration * 1000;
    if (!v.videoWidth || !v.videoHeight || !Number.isFinite(srcDurMs) || srcDurMs <= 0)
      return null;
    const fh = FRAME_H;
    const fw = Math.max(2, Math.round((fh * v.videoWidth) / v.videoHeight));
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(srcDurMs / 1500)));
    const strip = document.createElement("canvas");
    strip.width = n * fw;
    strip.height = fh;
    const g = strip.getContext("2d");
    if (!g) return null;
    for (let i = 0; i < n; i++) {
      await seekTo(v, ((i + 0.5) * srcDurMs) / n / 1000);
      g.drawImage(v, i * fw, 0, fw, fh);
    }
    return { strip, srcDurMs };
  } catch {
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

function spriteFor(srcPath: string): Promise<Sprite | null> {
  let p = sprites.get(srcPath);
  if (!p) {
    p = buildSprite(srcPath);
    sprites.set(srcPath, p);
  }
  return p;
}

export function FilmstripCanvas({
  srcPath,
  sourceInMs,
  durationMs,
  heightPx,
  widthPx,
}: {
  srcPath: string;
  sourceInMs: number;
  durationMs: number;
  heightPx: number;
  widthPx: number;
}) {
  const [sprite, setSprite] = useState<Sprite | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    spriteFor(srcPath).then((s) => {
      if (live) setSprite(s);
    });
    return () => {
      live = false;
    };
  }, [srcPath]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !sprite) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const W = cv.width;
    const H = cv.height;
    g.clearRect(0, 0, W, H);
    const sx = Math.max(0, (sourceInMs / sprite.srcDurMs) * sprite.strip.width);
    const sw = Math.min(
      sprite.strip.width - sx,
      (durationMs / sprite.srcDurMs) * sprite.strip.width,
    );
    if (sw <= 0) return;
    g.drawImage(sprite.strip, sx, 0, sw, sprite.strip.height, 0, 0, W, H);
  }, [sprite, sourceInMs, durationMs, widthPx, heightPx]);

  if (!sprite) return null;
  return (
    <canvas
      ref={canvasRef}
      width={Math.max(2, Math.round(widthPx))}
      height={Math.max(2, Math.round(heightPx))}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-40"
    />
  );
}
