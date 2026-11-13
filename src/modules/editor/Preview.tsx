import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProject } from "@/stores/project";
import { effectiveDoc } from "@/lib/timeline-engine";
import { useEditor } from "@/stores/editor";
import {
  activeClipsAt,
  clipRect,
  timelineDuration,
  transitionAlpha,
} from "@/lib/timeline-engine";
import { cssFilterFor, evalKeyframes, svgMatrixFor } from "@/lib/effects";
import type { Clip } from "@/lib/project-types";
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

const pct = (n: number, total: number) => `${(n / total) * 100}%`;

export function Preview({
  assets,
  docOverride,
}: {
  assets: Map<string, AssetSummary>;
  /** Render this doc instead of the store's active view (compare mode). */
  docOverride?: import("@/lib/project-types").ProjectDoc;
}) {
  const doc = useProject((s) => s.doc);
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const mediaEls = useRef(new Map<string, HTMLMediaElement>());
  const previewQuality = useEditor((s) => s.previewQuality);

  // Master clock: advance playhead while playing. Also monitors real frame
  // times — if the rAF cadence stays ≥1.5× the project's frame budget for a
  // sustained window, preview quality auto-degrades to "proxy" (ADR-019).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const budget = (() => {
      const d = useProject.getState().doc;
      if (!d) return 1000 / 30;
      return 1000 / (d.canvas.fpsNum / d.canvas.fpsDen);
    })();
    let slowCount = 0;
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
      // ~2s sustained over-budget → degrade once per session.
      slowCount = dt > budget * 1.5 ? slowCount + 1 : 0;
      if (slowCount > 60 && useEditor.getState().previewQuality === "full") {
        useEditor.getState().setPreviewQuality("proxy");
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, setPlayhead, setPlaying]);

  if (!doc) return null;
  const viewDoc = docOverride ?? effectiveDoc(doc, activeVersionId);
  const activeVersion = docOverride
    ? undefined
    : doc.versions.find((v) => v.id === activeVersionId);

  /** Transform evaluated at playhead: base values overlaid by keyframes. */
  const evalTransform = (clip: Clip) => {
    const rel = playheadMs - clip.startMs;
    const t = clip.transform;
    const k = clip.keyframes;
    return {
      ...t,
      x: evalKeyframes(k["transform.x"], rel, t.x),
      y: evalKeyframes(k["transform.y"], rel, t.y),
      scaleX: evalKeyframes(k["transform.scaleX"], rel, t.scaleX),
      scaleY: evalKeyframes(k["transform.scaleY"], rel, t.scaleY),
      rotationDeg: evalKeyframes(k["transform.rotationDeg"], rel, t.rotationDeg),
      opacity:
        evalKeyframes(k["transform.opacity"], rel, t.opacity) *
        transitionAlpha(viewDoc, clip.id, playheadMs),
    };
  };

  const active = activeClipsAt(viewDoc, playheadMs);
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
    const vol = evalKeyframes(
      a.clip.keyframes["volume"],
      playheadMs - a.clip.startMs,
      a.clip.volume,
    );
    el.volume = Math.min(1, Math.max(0, vol)) * (a.track.muted ? 0 : 1);
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
          aspectRatio: `${viewDoc.canvas.width} / ${viewDoc.canvas.height}`,
          height: "min(100%, calc((100vw - 560px) * 9 / 16))",
          backgroundColor: viewDoc.canvas.background,
          containerType: "size",
        }}
      >
        {/* SVG defs for matrix-based effects (temperature). */}
        <svg width="0" height="0" className="absolute">
          {visual.map(({ clip }) => {
            const m = svgMatrixFor(clip.effects);
            if (!m) return null;
            return (
              <filter key={clip.id} id={`fx-${clip.id}`}>
                <feColorMatrix type="matrix" values={m.join(" ")} />
              </filter>
            );
          })}
        </svg>
        {visual.map(({ clip }) => {
          const asset = clip.mediaRef ? assets.get(clip.mediaRef) : undefined;
          const missing = !asset || asset.status === "missing";

          if (missing || !asset) {
            const r = clipRect(viewDoc, clip, viewDoc.canvas.width, viewDoc.canvas.height);
            return (
              <div
                key={clip.id}
                className="absolute flex items-center justify-center bg-zinc-800/80 text-xs text-zinc-400"
                style={{
                  left: pct(r.x, viewDoc.canvas.width),
                  top: pct(r.y, viewDoc.canvas.height),
                  width: pct(r.w, viewDoc.canvas.width),
                  height: pct(r.h, viewDoc.canvas.height),
                }}
              >
                {asset?.name ?? "missing media"}
              </div>
            );
          }
          const isImg = asset.kind === "image" || isImagePath(asset.filePath);
          // Evaluated transform (keyframes + transitions) — same math the
          // render plan encodes; parity asserted by e2e pixel tests.
          const evalT = evalTransform(clip);
          const evalClip: Clip = { ...clip, transform: evalT };
          const r = clipRect(
            doc,
            evalClip,
            asset.width ?? viewDoc.canvas.width,
            asset.height ?? viewDoc.canvas.height,
          );
          const filters = [
            svgMatrixFor(clip.effects) ? `url(#fx-${clip.id})` : "",
            cssFilterFor(clip.effects),
          ]
            .filter(Boolean)
            .join(" ");
          const style: React.CSSProperties = {
            left: pct(r.x, viewDoc.canvas.width),
            top: pct(r.y, viewDoc.canvas.height),
            width: pct(r.w, viewDoc.canvas.width),
            height: pct(r.h, viewDoc.canvas.height),
            opacity: Math.max(0, Math.min(1, evalT.opacity)),
            transform:
              evalT.rotationDeg !== 0
                ? `rotate(${evalT.rotationDeg}deg)`
                : undefined,
            filter: filters || undefined,
            objectFit: "fill",
            position: "absolute",
          };
          // Preview decodes the proxy when available + enabled; export always
          // reads originals — a proxy is display-only by design.
          const srcPath =
            previewQuality === "proxy" && asset.proxyPath
              ? asset.proxyPath
              : asset.filePath;
          const url = convertFileSrc(srcPath);
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

        {/* Prefetch window: clips starting within 3s get hidden decoders so
            activation doesn't stall on container open. Not synced — load-only. */}
        {viewDoc.timeline.tracks
          .flatMap((t) => t.clips)
          .filter(
            (c) =>
              c.startMs >= playheadMs &&
              c.startMs < playheadMs + 3000 &&
              !active.some((a) => a.clip.id === c.id),
          )
          .map((c) => {
            const asset = c.mediaRef ? assets.get(c.mediaRef) : undefined;
            if (!asset || asset.status === "missing") return null;
            const srcPath =
              previewQuality === "proxy" && asset.proxyPath
                ? asset.proxyPath
                : asset.filePath;
            return (
              <video
                key={`pf-${c.id}`}
                src={convertFileSrc(srcPath)}
                preload="auto"
                muted
                style={{ display: "none" }}
              />
            );
          })}

        {/* Text clips — same anchor model as render/text.rs drawtext:
            block positioned on canvas + transform.x/y offset (ADR-020). */}
        {active
          .filter((a) => a.track.kind === "text" && a.track.visible && a.clip.text)
          .map(({ clip }) => {
            const st = clip.textStyle;
            if (!st) return null;
            const evalT = evalTransform(clip);
            const justify =
              st.alignH === "left" ? "flex-start" : st.alignH === "right" ? "flex-end" : "center";
            const align =
              st.alignV === "top" ? "flex-start" : st.alignV === "bottom" ? "flex-end" : "center";
            return (
              <div
                key={clip.id}
                className="absolute inset-0 flex"
                style={{
                  justifyContent: justify,
                  alignItems: align,
                  opacity: Math.max(0, Math.min(1, evalT.opacity)),
                  transform: `translate(${pct(evalT.x, viewDoc.canvas.width)}, ${pct(evalT.y, viewDoc.canvas.height)})`,
                }}
              >
                <span
                  style={{
                    fontSize: `${(st.fontSizePx / viewDoc.canvas.height) * 100}cqh`,
                    color: st.color,
                    WebkitTextStroke:
                      st.outlineWidth > 0 && st.outlineColor
                        ? `${(st.outlineWidth / viewDoc.canvas.height) * 100}cqh ${st.outlineColor}`
                        : undefined,
                    background: st.backgroundColor ?? undefined,
                    padding: st.backgroundColor
                      ? `${(st.backgroundPadPx / viewDoc.canvas.height) * 100}cqh`
                      : undefined,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {clip.text}
                </span>
              </div>
            );
          })}

        {/* Safe-zone guides for the active version (ADR-021: guides only,
            never burned into render). */}
        {activeVersion &&
          (() => {
            const z = activeVersion.safeZones;
            if (z.top + z.bottom + z.left + z.right <= 0) return null;
            return (
              <div
                className="pointer-events-none absolute border border-dashed border-cyan-400/50"
                style={{
                  left: `${z.left * 100}%`,
                  top: `${z.top * 100}%`,
                  right: `${z.right * 100}%`,
                  bottom: `${z.bottom * 100}%`,
                }}
              />
            );
          })()}

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
                src={convertFileSrc(
                  previewQuality === "proxy" && asset.proxyPath
                    ? asset.proxyPath
                    : asset.filePath,
                )}
                preload="auto"
              />
            );
          })}
      </div>
    </div>
  );
}
