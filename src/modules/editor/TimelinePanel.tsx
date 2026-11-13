import { useCallback, useRef, useState } from "react";
import { Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  addClip,
  findClip,
  moveClip,
  removeClip,
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
 * Timeline panel: ruler + track lanes + clip blocks.
 * Interactions (all non-destructive edits through timeline-engine ops):
 *  - drag clip body   → move (frame-snapped + edge/playhead snapping)
 *  - drag clip edges  → trim (8px handles)
 *  - click ruler      → scrub playhead
 *  - S key / button   → split at playhead
 *  - Del              → remove selected
 *  - drop asset id    → add clip at drop position
 */

const TRACK_H = 44;
const SNAP_PX = 10;

export function TimelinePanel({ assets }: { assets: Map<string, AssetSummary> }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const setZoom = useEditor((s) => s.setZoom);
  const mutate = useEditor((s) => s.mutate);
  const mutateInGesture = useEditor((s) => s.mutateInGesture);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);

  const lanesRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const msToPx = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec]);
  const pxToMs = useCallback((px: number) => (px / pxPerSec) * 1000, [pxPerSec]);

  if (!doc) return null;
  const durationMs = Math.max(timelineDuration(doc), 10_000);
  const lanesW = msToPx(durationMs) + 200;

  /** Snap a candidate ms to playhead/clip edges within SNAP_PX. */
  const snap = (ms: number, ignoreClipId?: string): number => {
    const pts = snapPoints(doc, playheadMs).filter((p) => {
      // Don't snap to the dragged clip's own moving edges.
      if (!ignoreClipId) return true;
      const c = findClip(doc, ignoreClipId)?.clip;
      return !c || (p !== c.startMs && p !== c.startMs + c.durationMs);
    });
    for (const p of pts) {
      if (Math.abs(msToPx(p) - msToPx(ms)) <= SNAP_PX) return p;
    }
    return snapToFrame(ms, doc);
  };

  // --- interactions ---

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: "move" | "left" | "right") => {
    e.stopPropagation();
    select([clip.id]);
    beginGesture();
    setDragging(clip.id);
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const grabOffsetMs = pxToMs(e.clientX - laneRect.left) - clip.startMs;

    const onMove = (ev: PointerEvent) => {
      const cursorMs = pxToMs(ev.clientX - laneRect.left);
      if (mode === "move") {
        const target = snap(cursorMs - grabOffsetMs, clip.id);
        mutateInGesture((d) => moveClip(d, clip.id, target));
      } else {
        // Edge trim: desired absolute edge vs the clip's current edge.
        mutateInGesture((d) => {
          const cur = findClip(d, clip.id)?.clip;
          if (!cur) return d;
          const target = snap(cursorMs, clip.id);
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
      setDragging(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const seek = (ev: { clientX: number }) =>
      setPlayhead(snapToFrame(pxToMs(ev.clientX - rect.left), doc));
    seek(e);
    const onMove = (ev: PointerEvent) => seek(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
    mutate((d) => selection.reduce((acc, id) => removeClip(acc, id), d));
    select([]);
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
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

  return (
    <div className="flex h-full flex-col border-t border-border bg-card">
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
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setZoom(pxPerSec / 1.4)}>
          <ZoomOut className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setZoom(pxPerSec * 1.4)}>
          <ZoomIn className="size-4" />
        </Button>
      </div>

      {/* Lanes */}
      <div ref={lanesRef} className="flex flex-1 overflow-auto">
        {/* Track headers */}
        <div className="sticky left-0 z-10 w-24 shrink-0 border-r border-border bg-card pt-6">
          {doc.timeline.tracks.map((t) => (
            <div
              key={t.id}
              className="flex items-center px-2 text-xs text-muted-foreground"
              style={{ height: TRACK_H }}
            >
              {t.name}
            </div>
          ))}
          {doc.timeline.tracks.length === 0 && (
            <div className="px-2 py-4 text-xs text-muted-foreground">{t("editor.dropHint")}</div>
          )}
        </div>

        {/* Ruler + lanes */}
        <div className="relative" style={{ width: lanesW, minWidth: "100%" }}>
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
              className="relative border-b border-border/50 bg-background/40"
              style={{ height: TRACK_H, width: lanesW }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, track)}
            >
              {track.clips.map((clip) => {
                const sel = selection.includes(clip.id);
                return (
                  <div
                    key={clip.id}
                    className={`group absolute top-1 flex cursor-grab items-stretch overflow-hidden rounded border text-[11px] select-none ${
                      sel
                        ? "border-primary bg-primary/30 z-20"
                        : "border-border bg-secondary/60 hover:bg-secondary/80"
                    } ${dragging === clip.id ? "z-30 opacity-90" : ""}`}
                    style={{
                      left: msToPx(clip.startMs),
                      width: Math.max(6, msToPx(clip.durationMs)),
                      height: TRACK_H - 8,
                    }}
                    onPointerDown={(e) => onClipPointerDown(e, clip, "move")}
                  >
                    <div
                      className="w-2 shrink-0 cursor-ew-resize bg-primary/40"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onClipPointerDown(e, clip, "left");
                      }}
                    />
                    <div className="flex flex-1 items-center truncate px-1">
                      {(clip.mediaRef && assets.get(clip.mediaRef)?.name) ?? "clip"} ·{" "}
                      {(clip.durationMs / 1000).toFixed(1)}s
                    </div>
                    <div
                      className="w-2 shrink-0 cursor-ew-resize bg-primary/40"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onClipPointerDown(e, clip, "right");
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}

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
  );
}
