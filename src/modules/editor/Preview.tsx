import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import { activeClipsAt, clipRect, timelineDuration } from "@/lib/timeline-engine";
import type { AssetSummary } from "@/lib/media-types";

/**
 * Preview compositor — one absolutely-positioned media element per active
 * clip inside a canvas-proportioned stage. Placement uses the same math the
 * render plan encodes as `overlay=x:y` (`clipRect`), so preview ≈ export.
 *
 * Transport: a single rAF master clock advances `playheadMs`; each mounted
 * element is seeked to `sourceMs` when drift exceeds ~90 ms and its
 * `playbackRate` mirrors `clip.speed`. Video elements carry their own audio;
 * audio-track clips use <audio> elements. Preview is allowed ~1 frame of
 * tolerance — export is the frame-exact path.
 */

const DRIFT_MS = 90;

function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(p);
}

export function Preview({ assets }: { assets: Map<string, AssetSummary> }) {
  const doc = useProject((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const mediaEls = useRef(new Map<string, HTMLMediaElement>());

  // Master clock: advance playhead while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const d = useProject.getState().doc;
      const cur = useEditor.getState().playheadMs;
      const end = d ? timelineDuration(d) : 0;
      if (cur + dt >= end) {
        setPlayhead(end);
        setPlaying(false);
        return;
      }
      setPlayhead(cur + dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, setPlayhead, setPlaying]);

  if (!doc) return null;

  const active = activeClipsAt(doc, playheadMs);
  const visual = active.filter((a) => a.track.visible && a.track.kind !== "audio");

  // Sync every mounted element to the model: seek on drift, rate, volume,
  // play/pause. Runs every playhead update — cheap for v1 clip counts.
  const syncEl = (clipId: string, el: HTMLMediaElement | null) => {
    if (!el) {
      mediaEls.current.delete(clipId);
      return;
    }
    mediaEls.current.set(clipId, el);
    const a = active.find((x) => x.clip.id === clipId);
    if (!a) {
      el.pause();
      return;
    }
    el.volume = Math.min(1, Math.max(0, a.clip.volume)) * (a.track.muted ? 0 : 1);
    el.playbackRate = a.clip.speed || 1;
    const want = a.sourceMs;
    if (Math.abs(el.currentTime * 1000 - want) > DRIFT_MS) {
      el.currentTime = want / 1000;
    }
    if (useEditor.getState().playing && el.paused) void el.play().catch(() => {});
    if (!useEditor.getState().playing && !el.paused) el.pause();
  };

  return (
    <div className="flex h-full items-center justify-center bg-black/60 p-4">
      <div
        className="relative max-h-full overflow-hidden rounded border border-border bg-black"
        style={{
          aspectRatio: `${doc.canvas.width} / ${doc.canvas.height}`,
          height: "min(100%, calc((100vw - 560px) * 9 / 16))",
          backgroundColor: doc.canvas.background,
        }}
      >
        {visual.map(({ clip }) => {
          const asset = clip.mediaRef ? assets.get(clip.mediaRef) : undefined;
          const missing = !asset || asset.status === "missing";
          const pct = (n: number, total: number) => `${(n / total) * 100}%`;
          if (missing || !asset) {
            const r = clipRect(doc, clip, doc.canvas.width, doc.canvas.height);
            return (
              <div
                key={clip.id}
                className="absolute flex items-center justify-center bg-zinc-800/80 text-xs text-zinc-400"
                style={{
                  left: pct(r.x, doc.canvas.width),
                  top: pct(r.y, doc.canvas.height),
                  width: pct(r.w, doc.canvas.width),
                  height: pct(r.h, doc.canvas.height),
                }}
              >
                {asset?.name ?? "missing media"}
              </div>
            );
          }
          const isImg = asset.kind === "image" || isImagePath(asset.filePath);
          const r = clipRect(
            doc,
            clip,
            asset.width ?? doc.canvas.width,
            asset.height ?? doc.canvas.height,
          );
          const style: React.CSSProperties = {
            left: pct(r.x, doc.canvas.width),
            top: pct(r.y, doc.canvas.height),
            width: pct(r.w, doc.canvas.width),
            height: pct(r.h, doc.canvas.height),
            opacity: clip.transform.opacity,
            transform:
              clip.transform.rotationDeg !== 0
                ? `rotate(${clip.transform.rotationDeg}deg)`
                : undefined,
            objectFit: "fill",
            position: "absolute",
          };
          const url = convertFileSrc(asset.filePath);
          return isImg ? (
            <img key={clip.id} src={url} style={style} alt={asset.name} draggable={false} />
          ) : (
            <video
              key={clip.id}
              ref={(el) => syncEl(clip.id, el)}
              src={url}
              style={style}
              preload="auto"
              playsInline
            />
          );
        })}

        {/* Audio-track elements (no visual). */}
        {active
          .filter((a) => a.track.kind === "audio" || (a.track.kind === "video" && !a.track.visible))
          .map(({ clip }) => {
            const asset = clip.mediaRef ? assets.get(clip.mediaRef) : undefined;
            if (!asset || asset.status === "missing") return null;
            return (
              <audio
                key={clip.id}
                ref={(el) => syncEl(clip.id, el)}
                src={convertFileSrc(asset.filePath)}
                preload="auto"
              />
            );
          })}
      </div>
    </div>
  );
}
