import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProject } from "@/stores/project";
import { effectiveDoc } from "@/lib/timeline-engine";
import { useEditor } from "@/stores/editor";
import {
  activeClipsAt,
  clipRect,
  findClip,
  setVersionClipOverride,
  timelineDuration,
  transitionAlpha,
  updateClip,
} from "@/lib/timeline-engine";
import { cssFilterFor, evalKeyframes, svgMatrixFor } from "@/lib/effects";
import { resumeAudio } from "@/services/audio-preview";
import type { Clip } from "@/lib/project-types";
import type { AssetSummary } from "@/lib/media-types";
import { angleDeg, scaleFromCorner, snapToGuides } from "@/lib/canvas-manip";
import { Button } from "@/components/ui/button";

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
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const mediaEls = useRef(new Map<string, HTMLMediaElement>());
  const dtMs = useRef(16);
  const previewQuality = useEditor((s) => s.previewQuality);
  const previewVolume = useEditor((s) => s.previewVolume);
  const previewMuted = useEditor((s) => s.previewMuted);
  const setPreviewVolume = useEditor((s) => s.setPreviewVolume);
  const setPreviewMuted = useEditor((s) => s.setPreviewMuted);
  const mutate = useEditor((s) => s.mutate);
  const mutateInGesture = useEditor((s) => s.mutateInGesture);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);
  const select = useEditor((s) => s.select);
  const stageRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const selection = useEditor((s) => s.selection);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const [editing, setEditing] = useState<string | null>(null);

  // Any user gesture re-arms the AudioContext: the WebAudio chain
  // (MediaElementSource → gain → destination) is silent while the context
  // is suspended, so resume eagerly, not only on the play toggle.
  useEffect(() => {
    const onDown = () => resumeAudio();
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  // Master clock: advance playhead while playing. Also monitors real frame
  // times — if the rAF cadence stays ≥1.5× the project's frame budget for a
  // sustained window, preview quality auto-degrades to "proxy" (ADR-019).
  useEffect(() => {
    if (!playing) return;
    resumeAudio();
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
      dtMs.current = dt;
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

  /** Drag a text/graphics element on the canvas → transform.x/y. Writes
      into the active version's override when one is set (ADR-021/027). */
  const dragClip = (clipId: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    select([clipId]);
    const stage = stageRef.current;
    const hit = findClip(viewDoc, clipId);
    if (!stage || !hit) return;
    beginGesture();
    const rect = stage.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = hit.clip.transform;
    const scaleX = viewDoc.canvas.width / Math.max(1, rect.width);
    const scaleY = viewDoc.canvas.height / Math.max(1, rect.height);
    const move = (ev: PointerEvent) => {
      const rawX = base.x + (ev.clientX - startX) * scaleX;
      const rawY = base.y + (ev.clientY - startY) * scaleY;
      const el = stage.querySelector(`[data-clip-id="${clipId}"]`);
      const ew = el ? (el.getBoundingClientRect().width * scaleX) : 0;
      const eh = el ? (el.getBoundingClientRect().height * scaleY) : 0;
      const snap = snapToGuides(rawX + ew / 2, rawY + eh / 2, viewDoc.canvas.width, viewDoc.canvas.height, 12);
      const nx = rawX + (snap.vGuide !== null ? snap.x - (rawX + ew / 2) : 0);
      const ny = rawY + (snap.hGuide !== null ? snap.y - (rawY + eh / 2) : 0);
      setGuides({ v: snap.vGuide, h: snap.hGuide });
      const d = useProject.getState().doc;
      if (!d) return;
      const versionId = useEditor.getState().activeVersionId;
      mutateInGesture((dd) =>
        versionId
          ? setVersionClipOverride(dd, versionId, clipId, {
              transform: { ...base, x: nx, y: ny },
            })
          : updateClip(dd, clipId, { transform: { x: nx, y: ny } }),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuides({ v: null, h: null });
      endGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const active = activeClipsAt(viewDoc, playheadMs);
  const visual = active.filter((a) => a.track.visible && a.track.kind !== "audio" && !a.clip.hidden);

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
    const rel = playheadMs - a.clip.startMs;
    const vol = evalKeyframes(a.clip.keyframes["volume"], rel, a.clip.volume);
    // fade envelope (clip-level fades — non-destructive)
    let fade = 1;
    if (a.clip.fadeInMs > 0) fade = Math.min(fade, rel / a.clip.fadeInMs);
    if (a.clip.fadeOutMs > 0)
      fade = Math.min(fade, (a.clip.durationMs - rel) / a.clip.fadeOutMs);
    fade = Math.max(0, Math.min(1, fade));
    // solo gate: when any track solos, only soloed tracks are audible
    const anySolo = active.some((x) => x.track.solo);
    const audible = (!a.track.muted && (!anySolo || a.track.solo)) ? 1 : 0;
    // Monitor gain: previewVolume/previewMuted only affect what the user
    // hears — clip/track volumes and the export mix are untouched.
    const monitor = previewMuted ? 0 : previewVolume;
    const gain = Math.max(0, vol * fade * (a.track.volume ?? 1)) * audible * monitor;
    // NOTE: media is served from http://asset.localhost — cross-origin to
    // the page, so MediaElementSource captures a CORS-tainted stream that
    // WebAudio renders as silence (measured rms=0). Until media is served
    // CORS-clean, gain goes through el.volume; the audio-preview chain
    // (EQ/comp/pan/ducking metering) stays disabled — it was silent anyway.
    // Export is unaffected (FFmpeg applies those).
    el.volume = Math.min(1, gain);
    el.playbackRate = a.clip.speed || 1;
    const want = a.sourceMs;
    if (Math.abs(el.currentTime * 1000 - want) > DRIFT_MS) {
      el.currentTime = want / 1000;
    }
    if (useEditor.getState().playing && el.paused)
      void el.play().catch((e) => console.warn("preview element play() rejected:", e));
    if (!useEditor.getState().playing && !el.paused) el.pause();
  };

  return (
    // inline-size container: the stage below sizes its height from 100cqw
    // so it always fits the pane — regardless of resizable panel widths.
    <div
      ref={paneRef}
      className="relative flex h-full items-center justify-center bg-black/60 p-4"
      style={{ containerType: "inline-size" }}
    >
      <div
        ref={stageRef}
        className="relative max-h-full overflow-hidden rounded border border-border bg-black"
        style={{
          aspectRatio: `${viewDoc.canvas.width} / ${viewDoc.canvas.height}`,
          // height so that width (height * aspect) ≤ pane width minus p-4
          height: `min(100%, calc((100cqw - 32px) * ${viewDoc.canvas.height} / ${viewDoc.canvas.width}))`,
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
          // Media-less clips (text/shape on text or graphics tracks) render in
          // their own layer below — they are never "missing media".
          if (!clip.mediaRef) return null;
          const asset = assets.get(clip.mediaRef);
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
            viewDoc,
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
            // Tailwind preflight sets `video, img { max-width: 100%; height:
            // auto }` — zoomed-in rects legitimately exceed the stage, so the
            // cap must be lifted or the media collapses to the left edge.
            maxWidth: "none",
          };
          // Preview decodes the proxy when available + enabled; export always
          // reads originals — a proxy is display-only by design.
          const srcPath =
            previewQuality === "proxy" && asset.proxyPath
              ? asset.proxyPath
              : asset.filePath;
          const url = convertFileSrc(srcPath);
          return isImg ? (
            <img
              key={clip.id}
              src={url}
              style={{ ...style, cursor: "move" }}
              alt={asset.name}
              draggable={false}
              data-clip-id={clip.id}
              onPointerDown={(e) => dragClip(clip.id, e)}
            />
          ) : (
            <video
              key={clip.id}
              ref={(el) => syncEl(clip.id, el)}
              src={url}
              style={{ ...style, cursor: "move" }}
              preload="auto"
              playsInline
              data-clip-id={clip.id}
              onPointerDown={(e) => dragClip(clip.id, e)}
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

        {/* Text/graphics clips — the canvas-sized wrapper carries
            scale/rotation so the pivot = canvas center, matching the
            render's scale+rotate on the layer (ADR-027). textFx:
            typewriter = prefix chars, wipe = clip-path reveal. */}
        {active
          .filter(
            (a) =>
              (a.track.kind === "text" || a.track.kind === "graphics") &&
              a.track.visible &&
              !a.clip.hidden &&
              (a.clip.text || a.clip.shape),
          )
          .map(({ clip }) => {
            const st = clip.textStyle;
            const evalT = evalTransform(clip);
            const justify =
              st?.alignH === "left" ? "flex-start" : st?.alignH === "right" ? "flex-end" : "center";
            const align =
              st?.alignV === "top" ? "flex-start" : st?.alignV === "bottom" ? "flex-end" : "center";
            const rel = playheadMs - clip.startMs;
            const fx = clip.textFx;
            let shown = clip.text ?? "";
            if (fx?.kind === "typewriter") {
              const cps = Math.max(0.1, fx.rate);
              const n = fx.out
                ? Math.ceil(((clip.durationMs - rel) / 1000) * cps)
                : Math.ceil((rel / 1000) * cps);
              shown = [...(clip.text ?? "")].slice(0, Math.max(0, n)).join("");
            }
            let clipPath: string | undefined;
            if (fx?.kind === "wipe") {
              const d0 = Math.max(1, fx.durationMs);
              const p = fx.out
                ? Math.max(0, Math.min(1, (rel - (clip.durationMs - d0)) / d0))
                : Math.max(0, Math.min(1, rel / d0));
              const d = fx.direction;
              clipPath = fx.out
                ? d === "rtl"
                  ? `inset(0 ${p * 100}% 0 0)`
                  : d === "ttb"
                    ? `inset(${p * 100}% 0 0 0)`
                    : d === "btt"
                      ? `inset(0 0 ${p * 100}% 0)`
                      : `inset(0 0 0 ${p * 100}%)`
                : d === "rtl"
                  ? `inset(0 0 0 ${(1 - p) * 100}%)`
                  : d === "ttb"
                    ? `inset(0 0 ${(1 - p) * 100}% 0)`
                    : d === "btt"
                      ? `inset(${(1 - p) * 100}% 0 0 0)`
                      : `inset(0 ${(1 - p) * 100}% 0 0)`;
            }
            // blur fx: mirrored dual branch (CSS blur + opacity weights) —
            // render forks the layer into gblur + geq alpha crossfade.
            let blurW = 0;
            let sharpW = 1;
            if (fx?.kind === "blur") {
              const d0 = Math.max(1, fx.durationMs);
              const p = fx.out
                ? Math.max(0, Math.min(1, (rel - (clip.durationMs - d0)) / d0))
                : Math.max(0, Math.min(1, rel / d0));
              if (fx.out) {
                sharpW = 1 - p;
                blurW = Math.min(1, p) * (1 - p);
              } else {
                blurW = 1 - p;
                sharpW = p;
              }
            }
            const sh = clip.shape;
            const textSpan = st && shown && (
              <span
                style={{
                  fontSize: `${(st.fontSizePx / viewDoc.canvas.height) * 100}cqh`,
                  color: st.color,
                  WebkitTextStroke:
                    st.outlineWidth > 0 && st.outlineColor
                      ? `${(st.outlineWidth / viewDoc.canvas.height) * 100}cqh ${st.outlineColor}`
                      : undefined,
                  textShadow:
                    st.shadowColor && (st.shadowX || st.shadowY)
                      ? `${((st.shadowX ?? 0) / viewDoc.canvas.width) * 100}cqw ${((st.shadowY ?? 0) / viewDoc.canvas.height) * 100}cqh 0 ${st.shadowColor}`
                      : undefined,
                  lineHeight: st.lineSpacingPx
                    ? `calc(1em + ${(st.lineSpacingPx / viewDoc.canvas.height) * 100}cqh)`
                    : undefined,
                  background: st.backgroundColor ?? undefined,
                  padding: st.backgroundColor
                    ? `${(st.backgroundPadPx / viewDoc.canvas.height) * 100}cqh`
                    : undefined,
                  whiteSpace: "pre-wrap",
                }}
              >
                {shown}
              </span>
            );
            const shapeDiv = sh && (
              <div
                className="absolute"
                style={{
                  width: `${(sh.widthPx / viewDoc.canvas.width) * 100}cqw`,
                  height: `${(sh.heightPx / viewDoc.canvas.height) * 100}cqh`,
                  background: sh.fill,
                  border:
                    sh.outlineWidth > 0 && sh.outlineColor
                      ? `${(sh.outlineWidth / viewDoc.canvas.height) * 100}cqh solid ${sh.outlineColor}`
                      : undefined,
                }}
              />
            );
            return (
              <div
                key={clip.id}
                className="absolute inset-0"
                style={{
                  opacity: Math.max(0, Math.min(1, evalT.opacity)),
                  transform: `scale(${evalT.scaleX}, ${evalT.scaleY})${
                    evalT.rotationDeg !== 0 ? ` rotate(${evalT.rotationDeg}deg)` : ""
                  }`,
                  clipPath,
                }}
              >
                {fx?.kind === "blur" && (
                  <div
                    className="absolute inset-0 flex"
                    style={{
                      justifyContent: justify,
                      alignItems: align,
                      transform: `translate(${pct(evalT.x, viewDoc.canvas.width)}, ${pct(evalT.y, viewDoc.canvas.height)})`,
                      filter: `blur(${((fx.rate || 12) / viewDoc.canvas.height) * 100}cqh)`,
                      opacity: Math.max(0, Math.min(1, blurW)),
                      pointerEvents: "none",
                    }}
                  >
                    {shapeDiv}
                    {textSpan}
                  </div>
                )}
                <div
                  className="absolute inset-0 flex"
                  style={{
                    justifyContent: justify,
                    alignItems: align,
                    transform: `translate(${pct(evalT.x, viewDoc.canvas.width)}, ${pct(evalT.y, viewDoc.canvas.height)})`,
                    opacity: fx?.kind === "blur" ? Math.max(0, Math.min(1, sharpW)) : 1,
                    pointerEvents: "auto",
                    cursor: "move",
                  }}
                  data-clip-id={clip.id}
                  onPointerDown={(e) => dragClip(clip.id, e)}
                  onDoubleClick={() => findClip(viewDoc, clip.id)?.track.kind === "text" && setEditing(clip.id)}
                >
                  {shapeDiv}
                  {textSpan}
                </div>
              </div>
            );
          })}

        {/* Subtitle cues — same model as ASS burn-in: margins anchor the
            block, karaoke/pop use real word timings (ADR-025). */}
        {(() => {
          const cue = viewDoc.subtitles.find(
            (c) => playheadMs >= c.startMs && playheadMs < c.endMs,
          );
          if (!cue) return null;
          const ss = viewDoc.subtitleStyle;
          const st = ss.text;
          const justify =
            st.alignH === "left" ? "flex-start" : st.alignH === "right" ? "flex-end" : "center";
          const align =
            st.alignV === "top" ? "flex-start" : st.alignV === "bottom" ? "flex-end" : "center";
          const mV = `${(ss.marginVPx / viewDoc.canvas.height) * 100}%`;
          const mH = `${(ss.marginHPx / viewDoc.canvas.width) * 100}%`;
          const wordSpan = (w: { word: string; startMs: number; endMs: number }, i: number) => {
            const spoken = playheadMs >= w.endMs;
            const active = playheadMs >= w.startMs && playheadMs < w.endMs;
            const color = active ? ss.highlightColor : st.color;
            if (ss.mode === "pop") return active ? <span key={i} style={{ color }}>{w.word.trim()}</span> : null;
            return (
              <span key={i} style={{ color, opacity: spoken || active ? 1 : 0.55 }}>
                {w.word}
              </span>
            );
          };
          return (
            <div
              className="pointer-events-none absolute flex"
              style={{
                justifyContent: justify,
                alignItems: align,
                inset: `${mV} ${mH} ${mV} ${mH}`,
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
                {ss.mode !== "none" && cue.words.length > 0
                  ? cue.words.map(wordSpan)
                  : cue.text}
              </span>
            </div>
          );
        })()}

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


        {/* Snap guide lines while dragging. */}
        {guides.v !== null && (
          <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent/70"
            style={{ left: `${(guides.v / viewDoc.canvas.width) * 100}%` }} />
        )}
        {guides.h !== null && (
          <div className="pointer-events-none absolute left-0 right-0 h-px bg-accent/70"
            style={{ top: `${(guides.h / viewDoc.canvas.height) * 100}%` }} />
        )}

        {/* Inline text edit on double-click. */}
        {editing && (() => {
          const hit = findClip(viewDoc, editing);
          if (!hit) { setEditing(null); return null; }
          return (
            <textarea
              autoFocus
              defaultValue={hit.clip.text ?? ""}
              className="absolute z-20 resize-none rounded border-2 border-accent bg-black/70 p-2 text-center text-cream outline-none"
              style={{ inset: "30% 20%", fontSize: 14 }}
              onBlur={(e) => {
                mutate((dd) => updateClip(dd, editing, { text: e.target.value }));
                setEditing(null);
              }}
              onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
            />
          );
        })()}

        {/* Audio-track elements (no visual). */}
        {active
          .filter(
            (a) =>
              !a.clip.hidden &&
              (a.track.kind === "audio" || (a.track.kind === "video" && !a.track.visible)),
          )
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

        {/* Transport — docked inside the canvas box so it stays centered on
            the real video in every aspect ratio (and per pane in compare),
            not on letterbox bands or between panes. */}
        <div
          className="absolute bottom-1.5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/90 px-3 py-1 backdrop-blur"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            onClick={() => setPlaying(!playing)}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <div className="h-4 w-px bg-border" />
          {/* Preview monitor volume — display-only, never exported. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            title={previewMuted ? t("editor.unmutePreview") : t("editor.mutePreview")}
            onClick={() => setPreviewMuted(!previewMuted)}
          >
            {previewMuted || previewVolume === 0 ? (
              <VolumeX className="size-4" />
            ) : (
              <Volume2 className="size-4" />
            )}
          </Button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={previewMuted ? 0 : previewVolume}
            title={t("editor.previewVolume")}
            aria-label={t("editor.previewVolume")}
            className="h-1 w-16 cursor-pointer accent-primary"
            onChange={(e) => {
              setPreviewVolume(Number(e.target.value));
              if (previewMuted) setPreviewMuted(false);
            }}
          />
        </div>
      </div>

        {/* Selection overlay: outline + resize/rotate handles + snap guides.
            All gestures write the same transform fields the FFmpeg render
            plan consumes, honoring active-version overrides. */}
        {(() => {
          const stage = stageRef.current;
          const pane = paneRef.current;
          const selId = selection.length === 1 ? selection[0] : null;
          if (!stage || !pane || !selId || editing) return null;
          const el = stage.querySelector<HTMLElement>(`[data-clip-id="${selId}"]`);
          const hit = selId ? findClip(viewDoc, selId) : null;
          if (!el || !hit) return null;
          const sr = stage.getBoundingClientRect();
          const pr = pane.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const box = { left: r.left - pr.left, top: r.top - pr.top, w: r.width, h: r.height };
          const kx = viewDoc.canvas.width / Math.max(1, sr.width);
          const ky = viewDoc.canvas.height / Math.max(1, sr.height);
          const write = (patch: Partial<typeof hit.clip.transform>) => {
            const versionId = useEditor.getState().activeVersionId;
            mutateInGesture((dd) =>
              versionId
                ? setVersionClipOverride(dd, versionId, selId, {
                    transform: { ...hit.clip.transform, ...patch },
                  })
                : updateClip(dd, selId, { transform: patch }),
            );
          };
          const corner = (e: React.PointerEvent) => {
            e.preventDefault(); e.stopPropagation();
            beginGesture();
            const sx = e.clientX, sy = e.clientY;
            const bs = hit.clip.transform;
            const mv = (ev: PointerEvent) => {
              const ns = scaleFromCorner(bs.scaleX, bs.scaleY, box.w / kx, box.h / ky,
                (ev.clientX - sx) * kx, (ev.clientY - sy) * ky);
              write({ scaleX: ns.scaleX, scaleY: ns.scaleY });
            };
            const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); endGesture(); };
            window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
          };
          // Single-axis edge resize — L/R stretch scaleX, T/B stretch
          // scaleY (sign flips so dragging the edge outward always grows).
          const edge = (axis: "x" | "y", sign: 1 | -1) => (e: React.PointerEvent) => {
            e.preventDefault(); e.stopPropagation();
            beginGesture();
            const sx = e.clientX, sy = e.clientY;
            const bs = hit.clip.transform;
            const mv = (ev: PointerEvent) => {
              const f = Math.max(
                0.05,
                axis === "x"
                  ? 1 + (sign * (ev.clientX - sx) * kx) / (box.w / kx)
                  : 1 + (sign * (ev.clientY - sy) * ky) / (box.h / ky),
              );
              write(axis === "x" ? { scaleX: bs.scaleX * f } : { scaleY: bs.scaleY * f });
            };
            const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); endGesture(); };
            window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
          };
          const rotate = (e: React.PointerEvent) => {
            e.preventDefault(); e.stopPropagation();
            beginGesture();
            const cx = box.left + box.w / 2, cy = box.top + box.h / 2;
            const mv = (ev: PointerEvent) => write({ rotationDeg: angleDeg(cx, cy, ev.clientX - pr.left, ev.clientY - pr.top) });
            const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); endGesture(); };
            window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
          };
          const sq = "absolute size-3 rounded-[3px] border border-accent bg-white shadow-sm";
          const ed = "absolute size-2.5 rounded-[2px] border border-accent bg-white shadow-sm";
          const corners: [number, number, string][] = [
            [-6, -6, "cursor-nwse-resize"],
            [box.w - 6, -6, "cursor-nesw-resize"],
            [-6, box.h - 6, "cursor-nesw-resize"],
            [box.w - 6, box.h - 6, "cursor-nwse-resize"],
          ];
          const edges: [number, number, string, "x" | "y", 1 | -1][] = [
            [box.w / 2 - 5, -5, "cursor-ns-resize", "y", -1],
            [box.w - 5, box.h / 2 - 5, "cursor-ew-resize", "x", 1],
            [box.w / 2 - 5, box.h - 5, "cursor-ns-resize", "y", 1],
            [-5, box.h / 2 - 5, "cursor-ew-resize", "x", -1],
          ];
          return (
            <div className="pointer-events-none absolute border-[1.5px] border-accent" style={box}>
              {/* Rotate knob on a stem — circle reads as rotation, not resize. */}
              <div className="absolute -top-5 left-1/2 flex -translate-x-1/2 flex-col items-center">
                <div
                  className="pointer-events-auto size-3 cursor-grab rounded-full border-2 border-accent bg-background"
                  onPointerDown={rotate}
                />
                <div className="h-2 w-px bg-accent" />
              </div>
              {corners.map(([x, y, cur], i) => (
                <div key={`c${i}`} className={`${sq} ${cur}`} style={{ left: x, top: y, pointerEvents: "auto" }} onPointerDown={corner} />
              ))}
              {edges.map(([x, y, cur, axis, sign], i) => (
                <div key={`e${i}`} className={`${ed} ${cur}`} style={{ left: x, top: y, pointerEvents: "auto" }} onPointerDown={edge(axis, sign)} />
              ))}
            </div>
          );
        })()}
    </div>
  );
}
