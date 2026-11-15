import { useCallback, useEffect, useRef, useState } from "react";
import {
  Blend,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Film,
  Lock,
  LockOpen,
  Magnet,
  Maximize,
  Music,
  Pencil,
  Plus,
  Scissors,
  Sparkles,
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
  addEffect,
  addTrack,
  addTransition,
  applyAnimationPreset,
  duplicateClips,
  extractClips,
  findClip,
  moveClips,
  moveClipToTrack,
  moveTrackOrder,
  removeClips,
  removeEffect,
  removeTrack,
  removeTransition,
  setTransitionDuration,
  renameTrack,
  setTrackFlag,
  snapPoints,
  snapToFrame,
  splitClip,
  timecode,
  timelineDuration,
  transitionsFor,
  trimClip,
  updateEffect,
  retimeClipKeyframes,
} from "@/lib/timeline-engine";
import { WaveformCanvas } from "@/modules/editor/WaveformCanvas";
import { FilmstripCanvas } from "@/modules/editor/FilmstripCanvas";
import { getDragPayload, isEffectPayload, type EffectCategory } from "@/lib/drag-payload";
import { effectDef } from "@/lib/effects";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AnchoredMenu,
  AnchoredMenuItem,
  AnchoredMenuSeparator,
} from "@/components/ui/anchored-menu";
import { useTranslation } from "react-i18next";
import type { Clip, Effect, Track, TrackKind, ProjectDoc, Transition } from "@/lib/project-types";
import type { AssetSummary } from "@/lib/media-types";

/**
 * Timeline panel: ruler + track headers + clip lanes.
 * All edits funnel through timeline-engine ops → useEditor.mutate, so every
 * interaction is undoable and coalesced per gesture.
 */

/** Soft per-kind clip tint so lanes read at a glance. */
const CLIP_TONES: Record<TrackKind, { bg: string; border: string }> = {
  video: { bg: "bg-sky-500/20", border: "border-sky-400/50" },
  audio: { bg: "bg-red-400/20", border: "border-red-400/50" },
  image: { bg: "bg-emerald-400/15", border: "border-emerald-400/50" },
  text: { bg: "bg-zinc-800/50", border: "border-zinc-500/50" },
  graphics: { bg: "bg-violet-400/15", border: "border-violet-400/50" },
};

const TRACK_H = 44;
/** Height of each effect strip row below the clip area of a lane. */
const FX_ROW_H = 10;
const BAR_COLORS = ["bg-violet-400", "bg-cyan-400", "bg-pink-400", "bg-lime-400"];
/** Lanes grow one row per stacked strip (effect or animation group);
    at least one row — every clip gets a visible fx slot to drop onto. */
const laneHeight = (fxRows: number) =>
  TRACK_H + Math.max(1, fxRows) * FX_ROW_H;
/** dropHint.trackId sentinel for the "new track" zone (not a real lane). */
const NEW_TRACK = "__new_track__";
const HEADER_W = 176;
const SNAP_PX = 10;

export function TimelinePanel({ assets }: { assets: Map<string, AssetSummary> }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  // NOTE: playheadMs updates at rAF rate — subscribing here would re-render
  // the whole timeline per frame. Handlers read getState() instead; the
  // moving UI lives in PlayheadOverlay/PlayheadTimecode below.
  const playheadNow = () => useEditor.getState().playheadMs;
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
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const mutateInGesture = useEditor((s) => s.mutateInGesture);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingTrack, setEditingTrack] = useState<string | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; clip: Clip; transition?: Transition } | null>(null);
  // Drop feedback: ghost position + validity for the lane under the pointer.
  const [dropHint, setDropHint] = useState<{
    trackId: string;
    startMs: number;
    durationMs: number;
    valid: boolean;
  } | null>(null);
  const dropHintRef = useRef<typeof dropHint>(null);
  // Lane under pointer while moving a clip (pointer-drag, not HTML5 DnD).
  const [moveLane, setMoveLane] = useState<{ trackId: string; valid: boolean } | null>(null);
  const setHint = (h: typeof dropHint) => {
    const p = dropHintRef.current;
    if (
      p === h ||
      (p && h && p.trackId === h.trackId && p.startMs === h.startMs &&
        p.durationMs === h.durationMs && p.valid === h.valid)
    )
      return;
    dropHintRef.current = h;
    setDropHint(h);
  };

  const msToPx = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec]);
  const pxToMs = useCallback((px: number) => (px / pxPerSec) * 1000, [pxPerSec]);

  // Auto-scroll to keep the playhead in view during playback — imperative
  // rAF loop mutates scrollLeft; no React re-render per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing || !doc) return;
    let raf = 0;
    const tick = () => {
      const px = msToPx(playheadNow());
      if (px > el.scrollLeft + el.clientWidth - 80 || px < el.scrollLeft) {
        el.scrollLeft = Math.max(0, px - 80);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, doc, msToPx]);

  // Wheel map — native listener (non-passive, so preventDefault actually
  // cancels): wheel → horizontal scroll, Shift+wheel → vertical scroll,
  // Ctrl+wheel → zoom anchored on the cursor (same anchor math as before).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const pps = useEditor.getState().pxPerSec;
        const cursorMs = ((e.clientX - rect.left + el.scrollLeft - HEADER_W) / pps) * 1000;
        const factor = e.deltaY < 0 ? 1.25 : 0.8;
        const next = Math.min(600, Math.max(20, pps * factor));
        useEditor.getState().setZoom(next);
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, (cursorMs / 1000) * next - (e.clientX - rect.left - HEADER_W));
        });
        return;
      }
      if (e.shiftKey) el.scrollTop += e.deltaY;
      else el.scrollLeft += e.deltaX !== 0 ? e.deltaX : e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // Re-attach only when the scroll container appears/disappears — not on
    // every doc mutation (scrubbing would churn listeners each frame).
  }, [doc != null]);

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
      const pts = snapPoints(doc, playheadNow()).filter((p) => !ignored.has(p));
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
    document.body.style.cursor = mode === "move" ? "grabbing" : "ew-resize";
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const grabOffsetMs = pxToMs(e.clientX - laneRect.left) - clip.startMs;
    const moving = sel.includes(clip.id) ? sel : [clip.id];
    // Per-frame displacement of the dragged clip — applied to the rest of
    // the selection so multi-clip drags move together. (Delta vs the
    // snapped target is ~0 and would leave the selection behind.)
    let prevStartMs = clip.startMs;

    const onMove = (ev: PointerEvent) => {
      const cursorMs = pxToMs(ev.clientX - laneRect.left);
      if (mode === "move") {
        const target = snap(cursorMs - grabOffsetMs, moving);
        // Vertical: which lane is the pointer over? Enables cross-track move.
        let targetTrackId = track.id;
        for (const l of document.querySelectorAll<HTMLElement>("[data-lane]")) {
          const r = l.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY < r.bottom) {
            targetTrackId = l.dataset.trackId ?? track.id;
            break;
          }
        }
        // Target-lane feedback: highlight + not-allowed cursor when the
        // move would be rejected (locked or kind-incompatible track).
        const targetTrack = doc.timeline.tracks.find((t) => t.id === targetTrackId);
        const validMove =
          !!targetTrack &&
          !targetTrack.locked &&
          (targetTrack.kind === "audio") === (track.kind === "audio");
        setMoveLane((p) =>
          p && p.trackId === targetTrackId && p.valid === validMove
            ? p
            : { trackId: targetTrackId, valid: validMove },
        );
        document.body.style.cursor = validMove ? "grabbing" : "not-allowed";
        mutateInGesture((d) => {
          // moveClipToTrack handles both same-track (moveClip) and
          // cross-track moves, with kind/lock checks built in.
          const next = moveClipToTrack(d, clip.id, targetTrackId, target);
          const cur = findClip(next, clip.id)?.clip;
          if (!cur) return next;
          const delta = cur.startMs - prevStartMs;
          prevStartMs = cur.startMs;
          const others = moving.filter((id) => id !== clip.id);
          return others.length && delta
            ? moveClips(next, others, delta)
            : next;
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
      document.body.style.cursor = "";
      setMoveLane(null);
      endGesture();
      setSnapLine(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Effect-window bar inside a clip: drag body = move the window, edges =
      stretch it. Window is clip-relative ms (inMs/outMs on the effect). */
  const onFxBarPointerDown = (
    e: React.PointerEvent,
    track: Track,
    clip: Clip,
    fx: Effect,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (track.locked) return;
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const in0 = fx.inMs ?? 0;
    const out0 = fx.outMs ?? clip.durationMs;
    const inX = laneRect.left + msToPx(clip.startMs + in0);
    const outX = laneRect.left + msToPx(clip.startMs + out0);
    const edge = e.clientX - inX < 8 ? "left" : outX - e.clientX < 8 ? "right" : "move";
    const startX = e.clientX;
    const MIN = 50;
    beginGesture();
    document.body.style.cursor = edge === "move" ? "grabbing" : "ew-resize";
    const onMove = (ev: PointerEvent) => {
      const dms = pxToMs(ev.clientX - startX);
      let ni = in0;
      let no = out0;
      if (edge === "move") {
        ni = in0 + dms;
        no = out0 + dms;
      } else if (edge === "left") {
        ni = in0 + dms;
      } else {
        no = out0 + dms;
      }
      ni = Math.max(0, Math.min(ni, clip.durationMs - MIN));
      no = Math.max(ni + MIN, Math.min(no, clip.durationMs));
      mutateInGesture((d) =>
        updateEffect(d, clip.id, fx.id, { inMs: Math.round(ni), outMs: Math.round(no) }),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      endGesture();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Drag a baked-animation strip (start/end presets + loose keyframes):
   *  body shifts the whole span, edges retime it proportionally. */
  const onAnimBarPointerDown = (
    e: React.PointerEvent,
    track: Track,
    clip: Clip,
    group: { tag: string | undefined; inMs: number; outMs: number },
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (track.locked) return;
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const in0 = group.inMs;
    const out0 = group.outMs;
    const inX = laneRect.left + msToPx(clip.startMs + in0);
    const outX = laneRect.left + msToPx(clip.startMs + out0);
    const edge = e.clientX - inX < 8 ? "left" : outX - e.clientX < 8 ? "right" : "move";
    const startX = e.clientX;
    const MIN = 50;
    // Track the span as APPLIED — mutateInGesture rewrites the doc every
    // pointermove, so the map must go from the current span to the target,
    // not from the original (re-applying a map to remapped times makes the
    // strip run away and can push tMs negative).
    let curIn = in0;
    let curOut = out0;
    beginGesture();
    document.body.style.cursor = edge === "move" ? "grabbing" : "ew-resize";
    const onMove = (ev: PointerEvent) => {
      const dms = pxToMs(ev.clientX - startX);
      let ni = in0;
      let no = out0;
      if (edge === "move") {
        ni = in0 + dms;
        no = out0 + dms;
      } else if (edge === "left") {
        ni = in0 + dms;
      } else {
        no = out0 + dms;
      }
      ni = Math.max(0, Math.min(ni, clip.durationMs - MIN));
      no = Math.max(ni + MIN, Math.min(no, clip.durationMs));
      const fi = curIn;
      const fo = curOut;
      const map = (t: number) =>
        fo <= fi ? t + (ni - fi) : ni + (t - fi) * ((no - ni) / (fo - fi));
      mutateInGesture((d) =>
        retimeClipKeyframes(d, clip.id, activeVersionId, group.tag, map),
      );
      curIn = ni;
      curOut = no;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      endGesture();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Drag a transition strip: edges stretch the overlap, body slides the
   *  junction — all resolve to setTransitionDuration (clip B realigns). */
  const onTransitionBarPointerDown = (
    e: React.PointerEvent,
    track: Track,
    tr: Transition,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (track.locked) return;
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void lane;
    const edge =
      e.clientX - rect.left < 8 ? "left" : rect.right - e.clientX < 8 ? "right" : "move";
    const d0 = tr.durationMs;
    const startX = e.clientX;
    const MIN = 50;
    beginGesture();
    document.body.style.cursor = edge === "move" ? "grabbing" : "ew-resize";
    const onMove = (ev: PointerEvent) => {
      const dms = pxToMs(ev.clientX - startX);
      // Left edge & body slide the junction (right = shorter overlap);
      // right edge grows/shrinks into clip A's tail.
      const nd = edge === "right" ? d0 + dms : d0 - dms;
      mutateInGesture((d) =>
        setTransitionDuration(d, track.id, tr.id, Math.max(MIN, nd)),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      endGesture();
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

  const fit = () => {
    const el = scrollRef.current;
    if (!el) return;
    const usable = el.clientWidth - HEADER_W - 40;
    setZoom((usable / Math.max(1000, timelineDuration(doc))) * 1000);
  };

  const splitAtPlayhead = () => {
    for (const clipId of selection) {
      mutate((d) => {
        const r = splitClip(d, clipId, playheadNow());
        return r ? r.doc : d;
      });
    }
  };

  const deleteSelected = () => {
    mutate((d) => removeClips(d, selection).doc);
    select([]);
  };

  // --- clip context menu (AnchoredMenu: portal → never clipped by the
  // scroll container, Escape/outside-click/arrow keys handled inside) ---
  const onClipContextMenu = (e: React.MouseEvent, track: Track, clip: Clip) => {
    e.preventDefault();
    e.stopPropagation();
    if (!useEditor.getState().selection.includes(clip.id)) select([clip.id]);
    setCtxMenu({ x: e.clientX, y: e.clientY, track, clip });
  };

  const ctxSplit = () => {
    for (const id of useEditor.getState().selection) {
      mutate((d) => {
        const r = splitClip(d, id, playheadNow());
        return r ? r.doc : d;
      });
    }
  };

  const ctxCopy = () => {
    const es = useEditor.getState();
    if (!es.selection.length || !doc) return;
    es.setClipboard(extractClips(doc, es.selection));
    toast.success(t("editor.copied", { count: es.selection.length }));
  };

  const ctxDuplicate = () => {
    const es = useEditor.getState();
    if (!es.selection.length) return;
    let ids: string[] = [];
    mutate((d) => {
      const r = duplicateClips(d, es.selection);
      ids = r.clipIds;
      return r.doc;
    });
    select(ids);
  };

  /** Lane validation shared by dragover (ghost/dropEffect) and drop —
      mirrors moveClipToTrack's rules: audio only on audio tracks, locked
      rejects everything. Unknown kind (foreign drag) stays permissive. */
  const dropValid = (track: Track, kind: string | undefined) =>
    !track.locked && (!kind || (track.kind === "audio") === (kind === "audio"));

  /** Effects-bin drops apply onto the clip under the cursor — every tile maps
      to a render-supported primitive (baked keyframes / xfade / clip.fx). */
  const applyFxDrop = (track: Track, ms: number, category: EffectCategory, itemId: string) => {
    if (track.locked) {
      toast.error(t("editor.dropLocked"));
      return;
    }
    if (track.kind === "audio") {
      toast.error(t("editor.fxNeedsVisualTrack"));
      return;
    }
    const target = track.clips.find(
      (c) => ms >= c.startMs && ms < c.startMs + c.durationMs,
    );
    if (!target) {
      toast.error(t("editor.fxDropOnClip"));
      return;
    }
    if (category === "merge") {
      const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
      const idx = sorted.indexOf(target);
      const prev = idx > 0 ? sorted[idx - 1] : undefined;
      const next = idx < sorted.length - 1 ? sorted[idx + 1] : undefined;
      const beforeMid = ms < target.startMs + target.durationMs / 2;
      const [a, b] = beforeMid && prev ? [prev, target]
        : !beforeMid && next ? [target, next]
        : prev ? [prev, target]
        : next ? [target, next]
        : [];
      if (!a || !b) {
        toast.error(t("editor.fxNeedsNeighbor"));
        return;
      }
      const gap = b.startMs - (a.startMs + a.durationMs);
      if (gap > 40) {
        toast.error(t("editor.fxNeedsAdjacent"));
        return;
      }
      let ok = false;
      mutate((d) => {
        const r = addTransition(d, track.id, a.id, b.id, 500, itemId);
        if (r) { ok = true; return r.doc; }
        return d;
      });
      if (ok) toast.success(t("editor.fxApplied", { name: itemId }));
      else toast.error(t("editor.fxNeedsAdjacent"));
      return;
    }
    if (category === "overlay") {
      const def = effectDef(itemId);
      if (!def) return;
      // Drop defaults are intentionally *visible* — a neutral param would
      // apply silently and read as "the drag didn't work".
      const VISIBLE: Record<string, number> = {
        amount: 0.25, stops: 0.5, radius: 8,
      };
      mutate((d) =>
        addEffect(d, target.id, {
          id: crypto.randomUUID(),
          type: def.type,
          enabled: true,
          params: Object.fromEntries(
            Object.entries(def.params).map(([k, s]) => [k, VISIBLE[k] ?? s.def]),
          ),
        }),
      );
      toast.success(t("editor.fxApplied", { name: def.label }));
      return;
    }
    // start / end → animation preset; duration capped at half the clip.
    const dur = Math.min(500, Math.max(50, target.durationMs / 2));
    mutate((d) =>
      applyAnimationPreset(d, target.id, itemId, {
        durationMs: dur,
        versionId: activeVersionId,
      }),
    );
    const label = itemId.replace(/([A-Z])/g, " $1").trim();
    toast.success(t("editor.fxApplied", { name: label }));
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    setHint(null);
    const fxJson = e.dataTransfer.getData("application/x-creatora-effect");
    if (fxJson) {
      const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
      const ms = snap(pxToMs(e.clientX - lane.getBoundingClientRect().left));
      try {
        const { category, itemId } = JSON.parse(fxJson);
        applyFxDrop(track, ms, category, itemId);
      } catch { /* malformed payload — ignore */ }
      return;
    }
    const assetId = e.dataTransfer.getData("application/x-creatora-asset");
    if (!assetId) return;
    if (track.locked) {
      toast.error(t("editor.dropLocked"));
      return;
    }
    const pl = getDragPayload();
    const kind = (pl && !isEffectPayload(pl) ? pl.kind : undefined) ?? assets.get(assetId)?.kind;
    if (!dropValid(track, kind)) {
      toast.error(t("editor.dropWrongTrack"));
      return;
    }
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const ms = snap(pxToMs(e.clientX - lane.getBoundingClientRect().left));
    const dur = Number(e.dataTransfer.getData("application/x-creatora-duration")) || 3000;
    const filePath = e.dataTransfer.getData("application/x-creatora-path");
    mutate((d) => {
      const r = addClip(d, {
        mediaRef: assetId,
        startMs: ms,
        durationMs: dur,
        sourceDurationMs: dur,
        trackKind: track.kind,
        trackId: track.id,
      });
      if (filePath && !r.doc.mediaRefs.some((m) => m.assetId === assetId)) {
        r.doc.mediaRefs.push({ assetId, path: filePath, hash: null });
      }
      return r.doc;
    });
    toast.success(t("editor.clipAdded"));
  };

  /** Drop outside any lane (empty timeline, or the space below the last
      lane): the timeline routes the asset by kind — audio creates/joins an
      audio track, video and images a video track. */
  const onDragOverNew = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes("application/x-creatora-asset")) {
      e.dataTransfer.dropEffect = "none";
      setHint(null);
      return;
    }
    const payload = getDragPayload();
    const lane = e.currentTarget as HTMLElement;
    const ms = snap(pxToMs(e.clientX - lane.getBoundingClientRect().left));
    e.dataTransfer.dropEffect = "copy";
    setHint({
      trackId: NEW_TRACK,
      startMs: ms,
      durationMs: payload && !isEffectPayload(payload) ? payload.durationMs : 3000,
      valid: true,
    });
  };

  const onDropNew = (e: React.DragEvent) => {
    e.preventDefault();
    setHint(null);
    const assetId = e.dataTransfer.getData("application/x-creatora-asset");
    if (!assetId) return;
    const pl2 = getDragPayload();
    const kind = (pl2 && !isEffectPayload(pl2) ? pl2.kind : undefined) ?? assets.get(assetId)?.kind;
    const lane = e.currentTarget as HTMLElement;
    const ms = snap(pxToMs(e.clientX - lane.getBoundingClientRect().left));
    const dur = Number(e.dataTransfer.getData("application/x-creatora-duration")) || 3000;
    const filePath = e.dataTransfer.getData("application/x-creatora-path");
    const trackKind = kind === "audio" ? "audio" : "video";
    mutate((d) => {
      // Empty space means "new lane": always create the track (V2, A2, …)
      // so a second asset of the same kind does not land on the first lane.
      const nt = addTrack(d, trackKind);
      const r = addClip(nt.doc, {
        mediaRef: assetId,
        startMs: ms,
        durationMs: dur,
        sourceDurationMs: dur,
        trackKind,
        trackId: nt.trackId,
      });
      if (filePath && !r.doc.mediaRefs.some((m) => m.assetId === assetId)) {
        r.doc.mediaRefs.push({ assetId, path: filePath, hash: null });
      }
      return r.doc;
    });
    toast.success(t("editor.clipAdded"));
  };

  /** Ghost shown while hovering empty space — mirrors the lane ghost. */
  const newTrackGhost = (
    <div
      className="pointer-events-none absolute top-1 rounded border-2 border-dashed border-primary/80 bg-primary/20"
      style={{
        left: msToPx(dropHint?.trackId === NEW_TRACK ? dropHint.startMs : 0),
        width: Math.max(6, msToPx(dropHint?.trackId === NEW_TRACK ? dropHint.durationMs : 0)),
        height: TRACK_H - 8,
      }}
    />
  );

  /** Baked-animation groups on a clip — one strip per preset tag, plus
   *  one for untagged (hand-placed) keyframes. Version-override paths
   *  shadow base, matching preview/render. */
  const clipAnimGroups = (clip: Clip) => {
    const ovKf = activeVersionId
      ? doc?.versions.find((v) => v.id === activeVersionId)?.clipOverrides[clip.id]?.keyframes
      : undefined;
    const eff = { ...clip.keyframes, ...(ovKf ?? {}) };
    const groups = new Map<string | undefined, { inMs: number; outMs: number }>();
    for (const arr of Object.values(eff))
      for (const k of arr) {
        const g = groups.get(k.anim) ?? { inMs: Infinity, outMs: -Infinity };
        g.inMs = Math.min(g.inMs, k.tMs);
        g.outMs = Math.max(g.outMs, k.tMs);
        groups.set(k.anim, g);
      }
    return [...groups.entries()].map(([tag, g]) => ({ tag, ...g }));
  };
  /** Stacked strip rows a clip needs: effects + animation groups. */
  const clipStripRows = (clip: Clip) =>
    clip.effects.length + clipAnimGroups(clip).length;
  const trackFxRows = (track: Track) =>
    Math.max(0, ...track.clips.map(clipStripRows)) +
    (track.transitions.length ? 1 : 0);

  // --- render ---

  const rulerTicks: number[] = [];
  const tickStepMs = pxPerSec >= 200 ? 250 : pxPerSec >= 100 ? 500 : pxPerSec >= 50 ? 1000 : 2000;
  for (let ms = 0; ms <= durationMs + 1000; ms += tickStepMs) rulerTicks.push(ms);

  const trackActions = (track: Track) => (
    <div className="flex items-center gap-0.5">
      <button
        className={`rounded p-0.5 hover:bg-accent ${track.locked ? "text-warning" : "text-muted-foreground"}`}
        title={t("editor.trackLock")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { locked: !track.locked }));
        }}
      >
        {track.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
      </button>
      <button
        className={`rounded p-0.5 hover:bg-accent ${!track.visible ? "text-warning" : "text-muted-foreground"}`}
        title={t("editor.trackVisible")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { visible: !track.visible }));
        }}
      >
        {track.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
      <button
        className={`rounded p-0.5 hover:bg-accent ${track.muted ? "text-warning" : "text-muted-foreground"}`}
        title={t("editor.trackMute")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { muted: !track.muted }));
        }}
      >
        {track.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </button>
      <button
        className={`rounded px-0.5 py-0.5 text-[9px] font-bold hover:bg-accent ${track.solo ? "text-accent-foreground" : "text-muted-foreground"}`}
        title={t("editor.trackSolo")}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => setTrackFlag(d, track.id, { solo: !track.solo }));
        }}
      >
        S
      </button>
      <input
        type="range"
        className="w-10 accent-cyan-500"
        min={0}
        max={2}
        step={0.01}
        value={track.volume ?? 1}
        title={t("editor.trackGain", { pct: ((track.volume ?? 1) * 100).toFixed(0) })}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          mutate((d) => setTrackFlag(d, track.id, { volume: Number(e.target.value) }))
        }
      />
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
    <div className="flex h-full flex-col border-t border-border bg-card">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <PlayheadTimecode doc={doc} durationMs={durationMs} />
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
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto"
        onDragLeave={(e) => {
          // Leaving the scroll region entirely → clear the ghost.
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
            setHint(null);
        }}
      >
        <div className="flex" style={{ width: HEADER_W + lanesW, minWidth: "100%" }}>
          {/* Track headers */}
          <div
            className="sticky left-0 z-40 shrink-0 border-r border-border bg-card pt-6"
            style={{ width: HEADER_W }}
          >
            {doc.timeline.tracks.map((track, ti) => (
              <div
                key={track.id}
                className={`flex items-center gap-1 border-b border-border/50 px-2 ${
                  track.locked ? "opacity-60" : ""
                }`}
                style={{ height: laneHeight(trackFxRows(track)) }}
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
          <div className="relative flex flex-1 flex-col">
            <div
              className="sticky top-0 z-30 h-6 cursor-ew-resize border-b border-border bg-card/95 backdrop-blur"
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
                data-track-id={track.id}
                className={cn(
                  "relative border-b border-border/50",
                  track.locked
                    ? "bg-secondary/25"
                    : track.visible
                      ? "bg-background/40"
                      : "bg-secondary/10",
                  // Drop-target highlight (media drag or cross-track move).
                  dropHint?.trackId === track.id &&
                    (dropHint.valid
                      ? "bg-primary/15 outline-1 -outline-offset-1 outline-primary/60"
                      : "bg-destructive/15 outline-1 -outline-offset-1 outline-destructive/60"),
                  moveLane?.trackId === track.id &&
                    (moveLane.valid ? "bg-primary/15" : "bg-destructive/15"),
                )}
                style={{ height: laneHeight(trackFxRows(track)), width: lanesW }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const lane = e.currentTarget as HTMLElement;
                  const ms = snap(pxToMs(e.clientX - lane.getBoundingClientRect().left));
                  // Effects-bin drop: ghost highlights the clip it would hit.
                  if (e.dataTransfer.types.includes("application/x-creatora-effect")) {
                    const target = track.clips.find(
                      (c) => ms >= c.startMs && ms < c.startMs + c.durationMs,
                    );
                    const valid =
                      !!target && !track.locked && track.kind !== "audio" &&
                      isEffectPayload(getDragPayload());
                    e.dataTransfer.dropEffect = valid ? "copy" : "none";
                    setHint(
                      target
                        ? { trackId: track.id, startMs: target.startMs, durationMs: target.durationMs, valid }
                        : null,
                    );
                    return;
                  }
                  if (!e.dataTransfer.types.includes("application/x-creatora-asset")) {
                    e.dataTransfer.dropEffect = "none";
                    setHint(null);
                    return;
                  }
                  const payload = getDragPayload();
                  const valid = dropValid(track, payload && !isEffectPayload(payload) ? payload.kind : undefined);
                  e.dataTransfer.dropEffect = valid ? "copy" : "none";
                  setHint({
                    trackId: track.id,
                    startMs: ms,
                    durationMs: payload && !isEffectPayload(payload) ? payload.durationMs : 3000,
                    valid,
                  });
                }}
                onDrop={(e) => onDrop(e, track)}
              >
                {/* Insertion ghost — where the clip will land. */}
                {dropHint?.trackId === track.id && (
                  <div
                    className={cn(
                      "pointer-events-none absolute top-1 rounded border-2 border-dashed",
                      dropHint.valid
                        ? "border-primary/80 bg-primary/20"
                        : "border-destructive/80 bg-destructive/20",
                    )}
                    style={{
                      left: msToPx(dropHint.startMs),
                      width: Math.max(6, msToPx(dropHint.durationMs)),
                      height: TRACK_H - 8,
                    }}
                  />
                )}
                {track.clips.map((clip) => {
                  const sel = selection.includes(clip.id);
                  const asset = clip.mediaRef ? assets.get(clip.mediaRef) : undefined;
                  // Still images import as kind "video" but have no
                  // duration — only timed sources get a filmstrip.
                  const isVideo = asset?.kind === "video" && asset.durationMs != null;
                  const tone = CLIP_TONES[track.kind];
                  return (
                    <div
                      key={clip.id}
                      className={`group absolute top-1 flex items-stretch overflow-hidden rounded border text-[11px] select-none ${tone.bg} ${
                        sel
                          ? "border-primary ring-1 ring-primary/60 z-20"
                          : `${tone.border} hover:brightness-110`
                      } ${track.locked ? "cursor-not-allowed opacity-70" : "cursor-grab"}`}
                      style={{
                        left: msToPx(clip.startMs),
                        width: Math.max(6, msToPx(clip.durationMs)),
                        height: TRACK_H - 8,
                      }}
                      onPointerDown={(e) => onClipPointerDown(e, track, clip, "move")}
                      onContextMenu={(e) => onClipContextMenu(e, track, clip)}
                    >
                      <div
                        className="w-2 shrink-0 cursor-ew-resize bg-primary/40"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onClipPointerDown(e, track, clip, "left");
                        }}
                      />
                      {isVideo && clip.mediaRef && (
                        <FilmstripCanvas
                          srcPath={
                            doc.mediaRefs.find((m) => m.assetId === clip.mediaRef)?.path ?? ""
                          }
                          sourceInMs={clip.sourceInMs}
                          sourceDurationMs={
                            clip.sourceDurationMs ?? asset.durationMs ?? clip.durationMs
                          }
                          heightPx={TRACK_H - 8}
                        />
                      )}
                      {clip.mediaRef &&
                        (track.kind === "audio" ||
                          (track.kind === "video" &&
                            !!assets.get(clip.mediaRef)?.audioCodec)) && (
                        <WaveformCanvas
                          srcPath={
                            doc.mediaRefs.find((m) => m.assetId === clip.mediaRef)?.path ?? ""
                          }
                          sourceInMs={clip.sourceInMs}
                          durationMs={clip.durationMs}
                          heightPx={TRACK_H - 8}
                          widthPx={Math.max(6, msToPx(clip.durationMs))}
                        />
                      )}
                      <div className="relative flex flex-1 items-center gap-1 truncate px-1">
                        {track.locked && <Lock className="size-3 shrink-0" />}
                        {(() => {
                          const ovKf = activeVersionId
                            ? doc.versions.find((v) => v.id === activeVersionId)
                                ?.clipOverrides[clip.id]?.keyframes
                            : undefined;
                          const n =
                            clip.effects.length +
                            Object.keys(clip.keyframes ?? {}).length +
                            Object.keys(ovKf ?? {}).length;
                          return n > 0 ? (
                            <span
                              className="flex shrink-0 items-center gap-0.5 rounded-sm bg-amber-400 px-0.5 text-[9px] font-bold text-black"
                              title={t("editor.fxBadge")}
                            >
                              <Sparkles className="size-2.5" />
                              {n}
                            </span>
                          ) : null;
                        })()}
                        {clip.shape && (
                          <span
                            className="size-3 shrink-0 rounded-sm border border-white/30"
                            style={{ background: clip.shape.fill }}
                          />
                        )}
                        <span className="truncate">
                          {(clip.mediaRef && assets.get(clip.mediaRef)?.name) ?? t("editor.clipFallback")} ·{" "}
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
                {/* Effect window strips — one row per effect in a sub-lane
                    below the clips. Every clip shows at least one empty
                    slot so there's always a place to drop/configure. */}
                {track.clips.map((clip) => {
                  const anims = clipAnimGroups(clip);
                  const rows = Math.max(1, clip.effects.length + anims.length);
                  return Array.from({ length: rows }, (_, i) => {
                    const top = TRACK_H - 2 + i * FX_ROW_H;
                    const fx = i < clip.effects.length ? clip.effects[i] : undefined;
                    const anim = fx ? undefined : anims[i - clip.effects.length];
                    if (anim) {
                      // Display clamps the strip to the clip; the handler
                      // keeps the raw span so a drag remaps real data.
                      const din = Math.max(0, Math.min(clip.durationMs, anim.inMs));
                      const dout = Math.max(din, Math.min(clip.durationMs, anim.outMs));
                      return (
                        <div
                          key={`${clip.id}-anim-${anim.tag ?? "kf"}`}
                          className={`absolute flex items-center rounded-sm bg-amber-400 px-1 text-[8px] font-medium leading-none text-black/80 ${track.locked ? "cursor-not-allowed" : "cursor-grab"}`}
                          style={{
                            left: msToPx(clip.startMs + din),
                            width: Math.max(6, msToPx(Math.max(dout - din, 1))),
                            top,
                            height: FX_ROW_H - 2,
                          }}
                          title={`${anim.tag ?? "keyframes"} · ${(din / 1000).toFixed(1)}–${(dout / 1000).toFixed(1)}s`}
                          onPointerDown={(e) => onAnimBarPointerDown(e, track, clip, anim)}
                        >
                          <span className="truncate">{anim.tag ?? "keyframes"}</span>
                        </div>
                      );
                    }
                    if (!fx) {
                      return (
                        <div
                          key={`${clip.id}-fx-empty`}
                          className="absolute cursor-pointer rounded-sm border border-dashed border-white/10 bg-white/[0.03] hover:border-white/25"
                          title={t("editor.fxEmpty")}
                          style={{
                            left: msToPx(clip.startMs),
                            width: Math.max(6, msToPx(clip.durationMs)),
                            top: top + 1,
                            height: FX_ROW_H - 3,
                          }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            select([clip.id]);
                          }}
                        />
                      );
                    }
                    const inMs = fx.inMs ?? 0;
                    const outMs = fx.outMs ?? clip.durationMs;
                    return (
                      <div
                        key={fx.id}
                        className={`absolute flex items-center rounded-sm px-1 text-[8px] font-medium leading-none text-black/80 ${BAR_COLORS[i % BAR_COLORS.length]} ${fx.enabled ? "" : "opacity-40"} ${track.locked ? "cursor-not-allowed" : "cursor-grab"}`}
                        style={{
                          left: msToPx(clip.startMs + inMs),
                          width: Math.max(6, msToPx(outMs - inMs)),
                          top,
                          height: FX_ROW_H - 2,
                        }}
                        title={`${fx.type} · ${(inMs / 1000).toFixed(1)}–${(outMs / 1000).toFixed(1)}s`}
                        onPointerDown={(e) => onFxBarPointerDown(e, track, clip, fx)}
                      >
                        <span className="truncate">{fx.type}</span>
                      </div>
                    );
                  });
                })}
                {/* Transition strips — one shared sub-lane row at the
                    bottom; edges resize, body slides the junction,
                    right-click removes. */}
                {track.transitions.map((tr) => {
                  const a = track.clips.find((c) => c.id === tr.clipA);
                  const b = track.clips.find((c) => c.id === tr.clipB);
                  if (!a || !b) return null;
                  const top =
                    TRACK_H - 2 +
                    Math.max(0, ...track.clips.map(clipStripRows)) * FX_ROW_H;
                  const start = b.startMs;
                  const w = Math.max(
                    12,
                    msToPx(Math.min(tr.durationMs, a.startMs + a.durationMs - start)),
                  );
                  return (
                    <div
                      key={`${tr.id}-strip`}
                      className={`absolute flex items-center rounded-sm bg-violet-500/90 px-1 text-[8px] font-medium leading-none text-white ${track.locked ? "cursor-not-allowed" : "cursor-ew-resize"}`}
                      style={{
                        left: msToPx(start),
                        width: w,
                        top,
                        height: FX_ROW_H - 2,
                      }}
                      title={`${tr.type} · ${(tr.durationMs / 1000).toFixed(2)}s`}
                      onPointerDown={(e) => onTransitionBarPointerDown(e, track, tr)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({ x: e.clientX, y: e.clientY, track, clip: b, transition: tr });
                      }}
                    >
                      <Blend className="mr-0.5 size-2.5 shrink-0" />
                      <span className="truncate">{tr.type}</span>
                    </div>
                  );
                })}
                {/* Transition markers — blend badge centered on each junction. */}
                {track.transitions.map((tr) => {
                  const a = track.clips.find((c) => c.id === tr.clipA);
                  const b = track.clips.find((c) => c.id === tr.clipB);
                  if (!a || !b) return null;
                  const start = b.startMs;
                  const w = Math.max(12, msToPx(Math.min(tr.durationMs, a.startMs + a.durationMs - start)));
                  return (
                    <div
                      key={tr.id}
                      className="absolute top-1 z-10 flex cursor-context-menu items-center justify-center rounded bg-violet-500/80 text-white hover:bg-violet-400"
                      title={`${tr.type} · ${(tr.durationMs / 1000).toFixed(2)}s`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({ x: e.clientX, y: e.clientY, track, clip: b, transition: tr });
                      }}
                      style={{ left: msToPx(start), width: w, height: TRACK_H - 8 }}
                    >
                      <Blend className="size-3" />
                    </div>
                  );
                })}
              </div>
            ))}
            {/* Drop zone below the last lane — creates a track of the
                dragged asset's kind. Only rendered when lanes exist;
                the empty state below is the whole-zone equivalent. */}
            {doc.timeline.tracks.length > 0 && (
              <div
                className={cn(
                  "relative min-h-[28px] flex-1",
                  dropHint?.trackId === NEW_TRACK &&
                    "bg-primary/15 outline-1 -outline-offset-1 outline-primary/60",
                )}
                style={{ width: lanesW }}
                onDragOver={onDragOverNew}
                onDrop={onDropNew}
              >
                {dropHint?.trackId === NEW_TRACK && newTrackGhost}
              </div>
            )}
            {doc.timeline.tracks.length === 0 && (
              <div
                className={cn(
                  "relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center",
                  dropHint?.trackId === NEW_TRACK &&
                    "bg-primary/15 outline-1 -outline-offset-1 outline-primary/60",
                )}
                style={{ width: lanesW }}
                onDragOver={onDragOverNew}
                onDrop={onDropNew}
              >
                {dropHint?.trackId === NEW_TRACK && newTrackGhost}
                <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <Film className="size-5" />
                </div>
                <p className="text-xs font-medium text-foreground">{t("editor.dropHint")}</p>
                <p className="max-w-xs text-[11px] text-muted-foreground">
                  {t("editor.dropHintEmpty")}
                </p>
              </div>
            )}

            {/* Snap indicator */}
            {snapLine !== null && (
              <div
                className="pointer-events-none absolute top-6 bottom-0 z-30 w-px bg-accent-foreground"
                style={{ left: msToPx(snapLine) }}
              />
            )}

            <PlayheadOverlay msToPx={msToPx} />
          </div>
        </div>
      </div>

      {/* Clip context menu */}
      <AnchoredMenu
        open={!!ctxMenu}
        onClose={() => setCtxMenu(null)}
        anchor={ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : null}
        side="bottom"
        align="start"
        offset={2}
        className="min-w-44"
      >
        {ctxMenu &&
          (() => {
            const ph = playheadNow();
            const inClip =
              ph > ctxMenu.clip.startMs && ph < ctxMenu.clip.startMs + ctxMenu.clip.durationMs;
            const locked = ctxMenu.track.locked;
            return (
              <>
                <AnchoredMenuItem
                  disabled={locked || !inClip}
                  onClick={() => {
                    ctxSplit();
                    setCtxMenu(null);
                  }}
                >
                  <Scissors className="size-3.5" /> {t("editor.split")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  onClick={() => {
                    ctxCopy();
                    setCtxMenu(null);
                  }}
                >
                  <Copy className="size-3.5" /> {t("editor.copy")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  disabled={locked}
                  onClick={() => {
                    ctxDuplicate();
                    setCtxMenu(null);
                  }}
                >
                  <CopyPlus className="size-3.5" /> {t("editor.duplicate")}
                </AnchoredMenuItem>
                {ctxMenu.transition && (
                  <AnchoredMenuItem
                    destructive
                    disabled={locked}
                    onClick={() => {
                      const tr = ctxMenu.transition!;
                      mutate((d) => removeTransition(d, ctxMenu.track.id, tr.id));
                      setCtxMenu(null);
                    }}
                  >
                    <Blend className="size-3.5" /> {t("editor.removeTransitionItem", { type: ctxMenu.transition.type })}
                  </AnchoredMenuItem>
                )}
                <AnchoredMenuItem
                  destructive
                  disabled={locked || !ctxMenu.clip.effects.length}
                  onClick={() => {
                    const clipId = ctxMenu.clip.id;
                    mutate((d) => {
                      let nd = d;
                      for (const fx of findClip(d, clipId)?.clip.effects ?? [])
                        nd = removeEffect(nd, clipId, fx.id);
                      return nd;
                    });
                    setCtxMenu(null);
                  }}
                >
                  <Sparkles className="size-3.5" /> {t("editor.removeEffects")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  destructive
                  disabled={
                    locked ||
                    (!Object.keys(ctxMenu.clip.keyframes ?? {}).length &&
                      !ctxMenu.clip.textFx &&
                      !(activeVersionId &&
                        doc.versions.find((v) => v.id === activeVersionId)
                          ?.clipOverrides[ctxMenu.clip.id]?.keyframes))
                  }
                  onClick={() => {
                    const clipId = ctxMenu.clip.id;
                    mutate((d) => {
                      const next = structuredClone(d);
                      const hit = findClip(next, clipId);
                      if (hit) {
                        hit.clip.keyframes = {};
                        hit.clip.textFx = null;
                      }
                      if (activeVersionId) {
                        const ov = next.versions.find((v) => v.id === activeVersionId)
                          ?.clipOverrides[clipId];
                        if (ov) {
                          delete ov.keyframes;
                          ov.textFx = null;
                        }
                      }
                      return next;
                    });
                    setCtxMenu(null);
                  }}
                >
                  <Sparkles className="size-3.5" /> {t("editor.removeAnimation")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  destructive
                  disabled={locked || !transitionsFor(doc, ctxMenu.clip.id).length}
                  onClick={() => {
                    const clipId = ctxMenu.clip.id;
                    const trackId = ctxMenu.track.id;
                    mutate((d) => {
                      let nd = d;
                      for (const tr of transitionsFor(d, clipId))
                        nd = removeTransition(nd, trackId, tr.id);
                      return nd;
                    });
                    setCtxMenu(null);
                  }}
                >
                  <Blend className="size-3.5" /> {t("editor.removeTransitions")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  destructive
                  disabled={locked}
                  onClick={() => {
                    deleteSelected();
                    setCtxMenu(null);
                  }}
                >
                  <Trash2 className="size-3.5" /> {t("editor.delete")}
                </AnchoredMenuItem>
                <AnchoredMenuSeparator />
                <AnchoredMenuItem
                  onClick={() => {
                    setEditingTrack(ctxMenu.track.id);
                    setCtxMenu(null);
                  }}
                >
                  <Pencil className="size-3.5" /> {t("editor.renameTrack")}
                </AnchoredMenuItem>
              </>
            );
          })()}
      </AnchoredMenu>
    </div>
  );
}

/** Playhead line — the ONLY piece that subscribes to playheadMs, so the
 * 60 fps store updates re-render this ~10-line div, not the whole panel. */
function PlayheadOverlay({ msToPx }: { msToPx: (ms: number) => number }) {
  const playheadMs = useEditor((s) => s.playheadMs);
  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-destructive"
      style={{ left: msToPx(playheadMs) }}
    >
      <div className="absolute -left-1.5 top-0 size-3 rotate-45 bg-destructive" />
    </div>
  );
}

/** Toolbar timecode — subscribes to playheadMs in isolation. */
function PlayheadTimecode({
  doc,
  durationMs,
}: {
  doc: ProjectDoc;
  durationMs: number;
}) {
  const playheadMs = useEditor((s) => s.playheadMs);
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {timecode(playheadMs, doc)} / {timecode(durationMs, doc)}
    </span>
  );
}
