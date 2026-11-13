import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Magnet,
  Maximize,
  Music,
  Plus,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  addClip,
  addTrack,
  findClip,
  moveClips,
  moveTrackOrder,
  removeClips,
  removeTrack,
  renameTrack,
  setTrackFlag,
  snapPoints,
  snapToFrame,
  splitClip,
  timecode,
  timelineDuration,
  trimClip,
} from "@/lib/timeline-engine";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { Clip, Track } from "@/lib/project-types";
import type { AssetSummary } from "@/lib/media-types";

/**
 * Timeline panel: ruler + track headers + clip lanes.
 * All edits funnel through timeline-engine ops → useEditor.mutate, so every
 * interaction is undoable and coalesced per gesture.
 */

const TRACK_H = 44;
const HEADER_W = 176;
const SNAP_PX = 10;

export function TimelinePanel({ assets }: { assets: Map<string, AssetSummary> }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useEditor((s) => s.playing);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const toggleSelect = useEditor((s) => s.toggleSelect);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const setZoom = useEditor((s) => s.setZoom);
  const snapEnabled = useEditor((s) => s.snapEnabled);
  const setSnapEnabled = useEditor((s) => s.setSnapEnabled);
  const mutate = useEditor((s) => s.mutate);
  const mutateInGesture = useEditor((s) => s.mutateInGesture);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingTrack, setEditingTrack] = useState<string | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);

  const msToPx = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec]);
  const pxToMs = useCallback((px: number) => (px / pxPerSec) * 1000, [pxPerSec]);

  // Auto-scroll to keep the playhead in view during playback.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing || !doc) return;
    const px = msToPx(playheadMs);
    if (px > el.scrollLeft + el.clientWidth - 80 || px < el.scrollLeft) {
      el.scrollLeft = Math.max(0, px - 80);
    }
  }, [playheadMs, playing, doc, msToPx]);

  if (!doc) return null;
  const durationMs = Math.max(timelineDuration(doc), 10_000);
  const lanesW = msToPx(durationMs) + 200;

  /** Snap candidates honoring snapEnabled + frame snapping always. */
  const snap = (ms: number, ignoreClipIds: string[] = []): number => {
    if (snapEnabled) {
      const ignored = new Set<number>();
      for (const id of ignoreClipIds) {
        const c = findClip(doc, id)?.clip;
        if (c) {
          ignored.add(c.startMs);
          ignored.add(c.startMs + c.durationMs);
        }
      }
      const pts = snapPoints(doc, playheadMs).filter((p) => !ignored.has(p));
      for (const p of pts) {
        if (Math.abs(msToPx(p) - msToPx(ms)) <= SNAP_PX) {
          setSnapLine(p);
          return p;
        }
      }
    }
    setSnapLine(null);
    return snapToFrame(ms, doc);
  };

  // --- clip interactions ---

  const onClipPointerDown = (e: React.PointerEvent, track: Track, clip: Clip, mode: "move" | "left" | "right") => {
    e.stopPropagation();
    if (track.locked && mode !== "move") return;
    // Selection: ctrl toggles; plain click selects this clip only.
    const sel = e.ctrlKey || e.metaKey
      ? (toggleSelect(clip.id), selection.includes(clip.id) ? selection.filter((x) => x !== clip.id) : [...selection, clip.id])
      : selection.includes(clip.id)
        ? selection
        : [clip.id];
    if (!e.ctrlKey && !e.metaKey) select(sel);
    if (track.locked) return; // locked: selectable but not editable

    beginGesture();
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const grabOffsetMs = pxToMs(e.clientX - laneRect.left) - clip.startMs;
    const moving = sel.includes(clip.id) ? sel : [clip.id];

    const onMove = (ev: PointerEvent) => {
      const cursorMs = pxToMs(ev.clientX - laneRect.left);
      if (mode === "move") {
        const target = snap(cursorMs - grabOffsetMs, moving);
        mutateInGesture((d) => {
          const cur = findClip(d, clip.id)?.clip;
          if (!cur) return d;
          return moveClips(d, moving, target - cur.startMs);
        });
      } else {
        mutateInGesture((d) => {
          const cur = findClip(d, clip.id)?.clip;
          if (!cur) return d;
          const target = snap(cursorMs, moving);
          const delta =
            mode === "left" ? target - cur.startMs : target - (cur.startMs + cur.durationMs);
          return trimClip(d, clip.id, mode === "left" ? "start" : "end", delta);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      endGesture();
      setSnapLine(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const seek = (ev: { clientX: number }) =>
      setPlayhead(snapToFrame(Math.max(0, pxToMs(ev.clientX - rect.left)), doc));
    seek(e);
    const onMove = (ev: PointerEvent) => seek(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Ctrl+wheel zoom anchored on the cursor.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cursorMs = pxToMs(e.clientX - rect.left + el.scrollLeft - HEADER_W);
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const next = Math.min(600, Math.max(20, pxPerSec * factor));
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, msToPx(cursorMs) - (e.clientX - rect.left - HEADER_W));
    });
  };

  const fit = () => {
    const el = scrollRef.current;
    if (!el) return;
    const usable = el.clientWidth - HEADER_W - 40;
    setZoom((usable / Math.max(1000, timelineDuration(doc))) * 1000);
  };

  const splitAtPlayhead = () => {
    for (const clipId of selection) {
      mutate((d) => {
        const r = splitClip(d, clipId, playheadMs);
        return r ? r.doc : d;
      });
    }
  };

  const deleteSelected = () => {
    mutate((d) => removeClips(d, selection).doc);
    select([]);
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    if (track.locked) return;
    const assetId = e.dataTransfer.getData("application/x-creatora-asset");
    if (!assetId) return;
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const ms = snap(pxToMs(e.clientX - lane.getBoundingClientRect().left));
    const dur = Number(e.dataTransfer.getData("application/x-creatora-duration")) || 3000;
    const filePath = e.dataTransfer.getData("application/x-creatora-path");
    mutate((d) => {
      const r = addClip(d, {
        mediaRef: assetId,
        startMs: ms,
        durationMs: dur,
        trackKind: track.kind,
      });
      if (filePath && !r.doc.mediaRefs.some((m) => m.assetId === assetId)) {
        r.doc.mediaRefs.push({ assetId, path: filePath, hash: null });
      }
      return r.doc;
    });
    toast.success(t("editor.clipAdded"));
  };

  // --- render ---

  const rulerTicks: number[] = [];
  const tickStepMs = pxPerSec >= 200 ? 250 : pxPerSec >= 100 ? 500 : pxPerSec >= 50 ? 1000 : 2000;
  for (let ms = 0; ms <= durationMs + 1000; ms += tickStepMs) rulerTicks.push(ms);

  const trackActions = (track: Track) => (
    <div className="flex items-center gap-0.5">
      <button
        className={`rounded p-0.5 hover:bg-accent ${track.locked ? "text-amber-400" : "text-muted-foreground"}`}
        title={t("editor.trackLock")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { locked: !track.locked }));
        }}
      >
        {track.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
      </button>
      <button
        className={`rounded p-0.5 hover:bg-accent ${!track.visible ? "text-amber-400" : "text-muted-foreground"}`}
        title={t("editor.trackVisible")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { visible: !track.visible }));
        }}
      >
        {track.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
      <button
        className={`rounded p-0.5 hover:bg-accent ${track.muted ? "text-amber-400" : "text-muted-foreground"}`}
        title={t("editor.trackMute")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { muted: !track.muted }));
        }}
      >
        {track.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </button>
      <button
        className="rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
        title={t("editor.trackDelete")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => removeTrack(d, track.id));
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );

  return (
    <div className="flex h-full flex-col border-t border-border bg-card" onWheel={onWheel}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="font-mono text-xs text-muted-foreground">
          {timecode(playheadMs, doc)} / {timecode(durationMs, doc)}
        </span>
        <div className="mx-2 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon" className="size-7" onClick={splitAtPlayhead} title={t("editor.split")}>
          <Scissors className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={deleteSelected} title={t("editor.delete")}>
          <Trash2 className="size-4" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          variant={snapEnabled ? "secondary" : "ghost"}
          size="icon"
          className="size-7"
          onClick={() => setSnapEnabled(!snapEnabled)}
          title={t("editor.snapToggle")}
        >
          <Magnet className="size-4" />
        </Button>
        <div className="flex-1" />
        <span className="mr-1 text-[10px] text-muted-foreground">
          {selection.length > 0 ? t("editor.selected", { count: selection.length }) : ""}
        </span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setZoom(pxPerSec / 1.4)}>
          <ZoomOut className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setZoom(pxPerSec * 1.4)}>
          <ZoomIn className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={fit} title={t("editor.zoomFit")}>
          <Maximize className="size-4" />
        </Button>
      </div>

      {/* Headers + lanes share one scroll container so they stay aligned. */}
      <div ref={scrollRef} className="relative flex-1 overflow-auto">
        <div className="flex" style={{ width: HEADER_W + lanesW, minWidth: "100%" }}>
          {/* Track headers */}
          <div
            className="sticky left-0 z-20 shrink-0 border-r border-border bg-card pt-6"
            style={{ width: HEADER_W }}
          >
            {doc.timeline.tracks.map((track, ti) => (
              <div
                key={track.id}
                className={`flex items-center gap-1 border-b border-border/50 px-2 ${
                  track.locked ? "opacity-60" : ""
                }`}
                style={{ height: TRACK_H }}
              >
                {editingTrack === track.id ? (
                  <input
                    autoFocus
                    className="w-16 rounded bg-background px-1 text-xs outline-none ring-1 ring-primary"
                    defaultValue={track.name}
                    onBlur={(e) => {
                      mutate((d) => renameTrack(d, track.id, e.target.value));
                      setEditingTrack(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingTrack(null);
                    }}
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 cursor-text truncate text-xs text-muted-foreground"
                    onDoubleClick={() => setEditingTrack(track.id)}
                    title={t("editor.trackRename")}
                  >
                    {track.name}
                  </span>
                )}
                <div className="flex flex-col gap-0">
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={ti === doc.timeline.tracks.length - 1}
                    title={t("editor.trackUp")}
                    onClick={() => mutate((d) => moveTrackOrder(d, track.id, 1))}
                  >
                    <span className="text-[9px]">▲</span>
                  </button>
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={ti === 0}
                    title={t("editor.trackDown")}
                    onClick={() => mutate((d) => moveTrackOrder(d, track.id, -1))}
                  >
                    <span className="text-[9px]">▼</span>
                  </button>
                </div>
                {trackActions(track)}
              </div>
            ))}
            <div className="flex gap-1 p-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-6 flex-1 text-[10px]"
                onClick={() => mutate((d) => addTrack(d, "video").doc)}
              >
                <Plus className="mr-0.5 size-3" /> {t("editor.addVideo")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 flex-1 text-[10px]"
                onClick={() => mutate((d) => addTrack(d, "audio").doc)}
              >
                <Music className="mr-0.5 size-3" /> {t("editor.addAudio")}
              </Button>
            </div>
          </div>

          {/* Ruler + lanes */}
          <div className="relative flex-1">
            <div
              className="sticky top-0 z-10 h-6 cursor-ew-resize border-b border-border bg-card/95 backdrop-blur"
              onPointerDown={onRulerPointerDown}
            >
              {rulerTicks.map((ms) => (
                <span
                  key={ms}
                  className="absolute border-l border-border pl-1 text-[10px] text-muted-foreground"
                  style={{ left: msToPx(ms), height: ms % (tickStepMs * 4) === 0 ? 24 : 12 }}
                >
                  {ms % (tickStepMs * 4) === 0 ? `${(ms / 1000).toFixed(0)}s` : ""}
                </span>
              ))}
            </div>

            {doc.timeline.tracks.map((track) => (
              <div
                key={track.id}
                data-lane
                className={`relative border-b border-border/50 ${
                  track.locked
                    ? "bg-secondary/25"
                    : track.visible
                      ? "bg-background/40"
                      : "bg-secondary/10"
                }`}
                style={{ height: TRACK_H, width: lanesW }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, track)}
              >
                {track.clips.map((clip) => {
                  const sel = selection.includes(clip.id);
                  return (
                    <div
                      key={clip.id}
                      className={`group absolute top-1 flex items-stretch overflow-hidden rounded border text-[11px] select-none ${
                        sel
                          ? "border-primary bg-primary/30 ring-1 ring-primary/60 z-20"
                          : "border-border bg-secondary/60 hover:bg-secondary/80"
                      } ${track.locked ? "cursor-not-allowed opacity-70" : "cursor-grab"}`}
                      style={{
                        left: msToPx(clip.startMs),
                        width: Math.max(6, msToPx(clip.durationMs)),
                        height: TRACK_H - 8,
                      }}
                      onPointerDown={(e) => onClipPointerDown(e, track, clip, "move")}
                    >
                      <div
                        className="w-2 shrink-0 cursor-ew-resize bg-primary/40"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onClipPointerDown(e, track, clip, "left");
                        }}
                      />
                      <div className="flex flex-1 items-center gap-1 truncate px-1">
                        {track.locked && <Lock className="size-3 shrink-0" />}
                        <span className="truncate">
                          {(clip.mediaRef && assets.get(clip.mediaRef)?.name) ?? "clip"} ·{" "}
                          {(clip.durationMs / 1000).toFixed(1)}s
                        </span>
                      </div>
                      <div
                        className="w-2 shrink-0 cursor-ew-resize bg-primary/40"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onClipPointerDown(e, track, clip, "right");
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
            {doc.timeline.tracks.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground">{t("editor.dropHint")}</div>
            )}

            {/* Snap indicator */}
            {snapLine !== null && (
              <div
                className="pointer-events-none absolute top-6 bottom-0 z-30 w-px bg-cyan-400"
                style={{ left: msToPx(snapLine) }}
              />
            )}

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-red-500"
              style={{ left: msToPx(playheadMs) }}
            >
              <div className="absolute -left-1.5 top-0 size-3 rotate-45 bg-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
