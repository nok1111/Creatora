import { useCallback, useEffect, useRef, useState } from "react";
import {
  Blend,
  Captions,
  Check,
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
  SkipBack,
  Sparkles,
  Trash2,
  Wand2,
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
  addCue,
  addEffect,
  addTrack,
  addTransition,
  applyAnimationPreset,
  autoTimeWords,
  diagnoseCues,
  duplicateClips,
  extractClips,
  findClip,
  moveClips,
  moveClipToTrack,
  moveCue,
  moveTrackOrder,
  removeClips,
  removeCue,
  removeEffect,
  duplicateCue,
  ensureSubtitleStyle,
  removeTrack,
  removeTransition,
  resizeCue,
  setCueStyle,
  setTransitionDuration,
  renameTrack,
  setTrackFlag,
  snapPoints,
  snapToFrame,
  splitClip,
  splitCue,
  timecode,
  timelineDuration,
  transitionsFor,
  trimClip,
  updateCue,
  updateEffect,
  updateTextFx,
  retimeClipKeyframes,
} from "@/lib/timeline-engine";
import { WaveformCanvas } from "@/modules/editor/WaveformCanvas";
import { FilmstripCanvas } from "@/modules/editor/FilmstripCanvas";
import { getDragPayload, isEffectPayload, type EffectCategory } from "@/lib/drag-payload";
import { effectDef, EFFECT_DROP_PARAMS } from "@/lib/effects";
import { fxEntry, fxTransition } from "@/lib/fx/manifest";
import { ANIM_PRESETS } from "@/lib/anim-presets";
import { SUBTITLE_PRESETS } from "@/lib/subtitle-presets";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AnchoredMenu,
  AnchoredMenuItem,
  AnchoredMenuSeparator,
} from "@/components/ui/anchored-menu";
import { useTranslation } from "react-i18next";
import type { Clip, Effect, Track, TrackKind, ProjectDoc, Transition, TextFx, SubtitleCue } from "@/lib/project-types";
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
/** Caption lane height — sits directly under the ruler, above the tracks. */
const SUB_LANE_H = 30;
/** Shortest a cue can be dragged/resized to. */
const MIN_CUE_MS = 200;
/** Default duration for a cue created by double-clicking the lane. */
const NEW_CUE_MS = 2000;
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
  // Caption-lane selection/inline-edit — cues live in doc.subtitles (ADR-025).
  const [selCueId, setSelCueId] = useState<string | null>(null);
  const [editCueId, setEditCueId] = useState<string | null>(null);
  const [cueCtx, setCueCtx] = useState<{ x: number; y: number; cue: SubtitleCue } | null>(null);
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

  // Active cue under the playhead — selector returns a primitive, so the
  // panel only re-renders when the active cue actually changes (cheap at
  // rAF rates during playback).
  const activeCueId = useEditor((s) => {
    const d = useProject.getState().doc;
    const cue = d?.subtitles.find(
      (c) => s.playheadMs >= c.startMs && s.playheadMs < c.endMs,
    );
    return cue?.id ?? null;
  });

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

  // Caption-lane keys: Delete removes the selected cue, S splits it at the
  // playhead. Clip selection is cleared when a cue is grabbed, so the
  // editor-level handlers don't double-fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selCueId) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        mutate((d) => removeCue(d, selCueId));
        setSelCueId(null);
      } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
        mutate((d) => {
          const r = splitCue(d, selCueId, playheadNow());
          if (r) setSelCueId(r.left);
          return r ? r.doc : d;
        });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Nudge: arrows move the cue one frame (Shift = ±0.5s).
        e.preventDefault();
        const d0 = useProject.getState().doc;
        if (!d0) return;
        const frameMs = (1000 * d0.canvas.fpsDen) / d0.canvas.fpsNum;
        const step = (e.shiftKey ? 500 : frameMs) * (e.key === "ArrowRight" ? 1 : -1);
        mutate((d) => {
          const cur = d.subtitles.find((c) => c.id === selCueId);
          return cur ? moveCue(d, selCueId, Math.max(0, cur.startMs + step)) : d;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selCueId, mutate]);

  if (!doc) return null;
  const durationMs = Math.max(timelineDuration(doc), 10_000);
  // The lane must stay reachable even for cues past the clip timeline end.
  const cuesEndMs = doc.subtitles.reduce((m, c) => Math.max(m, c.endMs), 0);
  const lanesW = msToPx(Math.max(durationMs, cuesEndMs)) + 200;
  // Cues overlapping a neighbor get a warning dot on the lane block.
  const cueOverlaps = new Set(
    diagnoseCues(doc).filter((i) => i.kind === "overlap").map((i) => i.cueId),
  );

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
      const pts = snapPoints(doc, playheadNow(), !useEditor.getState().playing).filter(
        (p) => !ignored.has(p),
      );
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
    e.preventDefault();
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

  /** TextFx strips are anchored (in → clip head, out → clip tail): only
      the free edge resizes. For typewriter the span maps back to `rate`
      (chars/s); for wipe/blur it maps to `durationMs`. */
  const onTextFxBarPointerDown = (
    e: React.PointerEvent,
    track: Track,
    clip: Clip,
    fx: TextFx,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (track.locked) return;
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const { inMs, outMs } = textFxSpan(clip, fx);
    const inX = laneRect.left + msToPx(clip.startMs + inMs);
    const outX = laneRect.left + msToPx(clip.startMs + outMs);
    const nearLeft = e.clientX - inX < 8;
    const nearRight = outX - e.clientX < 8;
    // Only the free edge is grabbable; anything else just selects.
    if (fx.out ? !nearLeft : !nearRight) {
      select([clip.id]);
      return;
    }
    const d0 = outMs - inMs;
    const nChars = [...(clip.text ?? "")].length || 1;
    const startX = e.clientX;
    beginGesture();
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: PointerEvent) => {
      const dms = pxToMs(ev.clientX - startX);
      // out: left edge grows the window leftward; in: right edge grows it.
      const nd = Math.max(50, Math.min(clip.durationMs, fx.out ? d0 - dms : d0 + dms));
      mutateInGesture((d) =>
        fx.kind === "typewriter"
          ? updateTextFx(d, clip.id, activeVersionId, { rate: (nChars * 1000) / nd })
          : updateTextFx(d, clip.id, activeVersionId, { durationMs: nd }),
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

  /** Cue block in the caption lane: drag body = move (duration kept),
      edges = retime. Same gesture plumbing as clips so drags are
      frame-snapped, undo-coalesced and cancel-safe. */
  const onCuePointerDown = (
    e: React.PointerEvent,
    cue: SubtitleCue,
    mode: "move" | "left" | "right",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelCueId(cue.id);
    setEditCueId(null);
    select([]);
    setPlayhead(cue.startMs);
    beginGesture();
    document.body.style.cursor = mode === "move" ? "grabbing" : "ew-resize";
    const lane = (e.currentTarget as HTMLElement).closest("[data-sublane]") as HTMLElement;
    const laneRect = lane.getBoundingClientRect();
    const grabOffsetMs = pxToMs(e.clientX - laneRect.left) - cue.startMs;

    const onMove = (ev: PointerEvent) => {
      const cursorMs = pxToMs(ev.clientX - laneRect.left);
      mutateInGesture((d) => {
        const cur = d.subtitles.find((c) => c.id === cue.id);
        if (!cur) return d;
        if (mode === "move") {
          const target = Math.max(0, Math.round(snap(cursorMs - grabOffsetMs)));
          // Scrub the preview to the dragged edge so the caption lands
          // against picture in real time (paused only — don't fight playback).
          if (!useEditor.getState().playing) setPlayhead(target);
          return moveCue(d, cue.id, target);
        }
        const target = Math.round(snap(cursorMs));
        if (mode === "left") {
          const s = Math.max(0, Math.min(target, cur.endMs - MIN_CUE_MS));
          if (!useEditor.getState().playing) setPlayhead(s);
          return resizeCue(d, cue.id, { startMs: s });
        }
        const en = Math.max(target, cur.startMs + MIN_CUE_MS);
        if (!useEditor.getState().playing) setPlayhead(en - 1);
        return resizeCue(d, cue.id, { endMs: en });
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      endGesture();
      setSnapLine(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
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
    // Manifest intro/outro effects (start/end bins) apply as windowed
    // clip effects: the window is the `duration` param at the clip edge.
    const libStartEnd = fxEntry(itemId);
    if (
      libStartEnd?.kind === "effect" &&
      ((category === "start" && libStartEnd.category === "intro") ||
        (category === "end" && libStartEnd.category === "outro"))
    ) {
      const dur = libStartEnd.params.find((p) => p.key === "duration")?.def ?? 800;
      const wMs = Math.min(dur, target.durationMs);
      mutate((d) =>
        addEffect(d, target.id, {
          id: crypto.randomUUID(),
          type: libStartEnd.id,
          enabled: true,
          params: Object.fromEntries(libStartEnd.params.map((p) => [p.key, p.def])),
          inMs: category === "end" ? Math.max(0, target.durationMs - wMs) : 0,
          outMs: category === "start" ? wMs : undefined,
        }),
      );
      toast.success(t("editor.fxApplied", { name: libStartEnd.name }));
      return;
    }
    // Animation presets — start/end tiles plus the combo/emphasis/loop
    // tiles under overlay — route to the keyframe path by id.
    const preset = ANIM_PRESETS.find((p) => p.id === itemId);
    if (preset) {
      // TextFx presets (empty paths) need a text/graphics host clip.
      if (preset.paths.length === 0 && track.kind !== "text" && track.kind !== "graphics") {
        toast.error(t("editor.fxNeedsTextTrack"));
        return;
      }
      // Loops bake over the whole clip; in/out cap at ~500ms and emphasis
      // (pulse/shake) is a quick ~900ms hit — a 15s pulse reads as a slow
      // zoom, not a beat.
      const dur =
        preset.category === "loop"
          ? target.durationMs
          : preset.category === "emphasis"
            ? Math.min(900, Math.max(50, target.durationMs))
            : Math.min(500, Math.max(50, target.durationMs / 2));
      mutate((d) =>
        applyAnimationPreset(d, target.id, itemId, {
          durationMs: dur,
          versionId: activeVersionId,
        }),
      );
      const label = itemId.replace(/([A-Z])/g, " $1").trim();
      toast.success(t("editor.fxApplied", { name: label }));
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
        const lib = fxTransition(itemId);
        const r = addTransition(d, track.id, a.id, b.id, lib?.defaultDurationMs ?? 500, itemId, lib ? { ease: lib.defaultEase } : undefined);
        if (r) { ok = true; return r.doc; }
        return d;
      });
      if (ok) toast.success(t("editor.fxApplied", { name: fxTransition(itemId)?.name ?? itemId }));
      else toast.error(t("editor.fxNeedsAdjacent"));
      return;
    }
    if (category === "overlay") {
      // Manifest effects/filters (kind:"effect"|"filter") apply with their
      // manifest param defaults; filters are capped at 3 active per clip.
      const lib = fxEntry(itemId);
      if (lib && (lib.kind === "effect" || lib.kind === "filter")) {
        const activeFilters = target.effects.filter(
          (x) => x.enabled && fxEntry(x.type)?.kind === "filter",
        ).length;
        if (lib.kind === "filter" && activeFilters >= 3) {
          toast.error("Maximum 3 filters per clip — remove one first");
          return;
        }
        mutate((d) =>
          addEffect(d, target.id, {
            id: crypto.randomUUID(),
            type: lib.id,
            enabled: true,
            params: Object.fromEntries(lib.params.map((p) => [p.key, p.def])),
          }),
        );
        toast.success(t("editor.fxApplied", { name: lib.name }));
        return;
      }
      const def = effectDef(itemId);
      if (!def) return;
      // Drop defaults are signature-strength (EFFECT_DROP_PARAMS) — a
      // neutral param applies silently, and a uniform 0.25 makes sepia
      // indistinguishable from temperature.
      mutate((d) =>
        addEffect(d, target.id, {
          id: crypto.randomUUID(),
          type: def.type,
          enabled: true,
          params: Object.fromEntries(
            Object.entries(def.params).map(([k, s]) => [
              k,
              EFFECT_DROP_PARAMS[def.type]?.[k] ?? s.def,
            ]),
          ),
        }),
      );
      toast.success(t("editor.fxApplied", { name: def.label }));
      return;
    }
    toast.error(t("editor.fxDropOnClip"));
  };

  // "Apply" button of the Effects bin: target = the selected clip.
  useEffect(() => {
    const h = (ev: Event) => {
      const { category, itemId } = (ev as CustomEvent<{ category: EffectCategory; itemId: string }>).detail;
      const d = useProject.getState().doc;
      const id = useEditor.getState().selection[0];
      if (!d || !id) {
        toast.error(t("editor.fxDropOnClip"));
        return;
      }
      const track = d.timeline.tracks.find((tr) => tr.clips.some((c) => c.id === id));
      const clip = track?.clips.find((c) => c.id === id);
      if (track && clip) applyFxDrop(track, clip.startMs + 1, category, itemId);
    };
    window.addEventListener("creatora:apply-fx", h);
    return () => window.removeEventListener("creatora:apply-fx", h);
  });

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
  /** Effective textFx — version override wins; an explicit null in the
      override means "removed for this version". */
  const clipTextFx = (clip: Clip): TextFx | null => {
    const ovFx = activeVersionId
      ? doc?.versions.find((v) => v.id === activeVersionId)?.clipOverrides[clip.id]?.textFx
      : undefined;
    return ovFx !== undefined ? ovFx : (clip.textFx ?? null);
  };
  /** Clip-relative span a textFx occupies: the wipe/blur window, or the
      typewriter span derived from chars/rate. `out` variants anchor at
      the clip tail, `in` variants at the head. */
  const textFxSpan = (clip: Clip, fx: TextFx) => {
    let dur = fx.durationMs;
    if (fx.kind === "typewriter") {
      const n = [...(clip.text ?? "")].length || 1;
      dur = (n / Math.max(0.1, fx.rate)) * 1000;
    }
    dur = Math.max(50, Math.min(clip.durationMs, dur));
    return fx.out
      ? { inMs: clip.durationMs - dur, outMs: clip.durationMs }
      : { inMs: 0, outMs: dur };
  };
  /** Stacked strip rows a clip needs: effects + animation groups + textFx. */
  const clipStripRows = (clip: Clip) =>
    clip.effects.length + clipAnimGroups(clip).length + (clipTextFx(clip) ? 1 : 0);
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
        className={`rounded px-0.5 py-0.5 text-[10px] font-bold hover:bg-accent ${track.solo ? "text-accent-foreground" : "text-muted-foreground"}`}
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
        className="w-10 accent-primary"
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
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={t("editor.toStart")}
          onClick={() => {
            setPlayhead(0);
            if (scrollRef.current) scrollRef.current.scrollLeft = 0;
          }}
        >
          <SkipBack className="size-4" />
        </Button>
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
        className="relative flex-1 select-none overflow-auto"
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
            {/* Caption-lane header — fixed row aligned with the CC lane,
                pinned under the ruler on vertical scroll. */}
            <div
              className="sticky top-6 z-10 flex items-center gap-1.5 border-b border-border/50 bg-card px-2"
              style={{ height: SUB_LANE_H }}
            >
              <Captions className="size-3 shrink-0 text-emerald-400" />
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {t("subs.captions")}
                {doc.subtitles.length > 0 && (
                  <span className="ml-1 text-[10px] text-muted-foreground/60">
                    {doc.subtitles.length}
                  </span>
                )}
              </span>
              <button
                className="text-muted-foreground hover:text-foreground"
                title={t("subs.addCueAtPlayhead")}
                onClick={() => {
                  const at = Math.round(playheadNow());
                  mutate(
                    (d) =>
                      addCue(d, {
                        startMs: at,
                        endMs: at + NEW_CUE_MS,
                        text: "",
                        words: [],
                      }).doc,
                  );
                }}
              >
                <Plus className="size-3" />
              </button>
            </div>
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
                    title={`${track.name} — ${t("editor.trackRename")}`}
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
                    <span className="text-[10px]">▲</span>
                  </button>
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    disabled={ti === 0}
                    title={t("editor.trackDown")}
                    onClick={() => mutate((d) => moveTrackOrder(d, track.id, -1))}
                  >
                    <span className="text-[10px]">▼</span>
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

            {/* Caption lane — cues as draggable blocks on the same timebase.
                Click seeks; drag body/edges retimes; double-click edits text;
                double-click empty space creates a cue. */}
            <div
              data-sublane
              className="sticky top-6 z-20 border-b border-emerald-500/25 bg-card"
              style={{ height: SUB_LANE_H, width: lanesW }}
              onPointerDown={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setSelCueId(null);
                setPlayhead(
                  snapToFrame(Math.max(0, pxToMs(e.clientX - rect.left)), doc),
                );
              }}
              onDoubleClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ms = Math.max(0, Math.round(pxToMs(e.clientX - rect.left)));
                let newId = "";
                mutate((d) => {
                  const r = addCue(d, {
                    startMs: ms,
                    endMs: ms + NEW_CUE_MS,
                    text: "",
                    words: [],
                  });
                  newId = r.cueId;
                  return r.doc;
                });
                setSelCueId(newId);
                setEditCueId(newId);
              }}
            >
              {doc.subtitles.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center pl-2 text-[10px] text-muted-foreground/60">
                  {t("subs.laneHint")}
                </div>
              )}
              {doc.subtitles.map((cue) => {
                const sel = selCueId === cue.id;
                const editing = editCueId === cue.id;
                const active = activeCueId === cue.id;
                const w = Math.max(10, msToPx(cue.endMs - cue.startMs));
                // Per-cue styled blocks take their text color as accent.
                const accent = cue.styleId
                  ? doc.subtitleStyles?.find((s) => s.id === cue.styleId)?.style.text.color
                  : undefined;
                const accentStyle = accent
                  ? { borderColor: accent, backgroundColor: `${accent}33` }
                  : undefined;
                return (
                  <div
                    key={cue.id}
                    data-cue={cue.id}
                    className={cn(
                      "absolute top-[3px] h-[24px] rounded border text-[10px] leading-[22px]",
                      editing ? "overflow-visible" : "overflow-hidden",
                      sel
                        ? "z-10 border-emerald-300 bg-emerald-400/40 text-emerald-50"
                        : active
                          ? "border-emerald-200 bg-emerald-400/35 text-emerald-50"
                          : cueOverlaps.has(cue.id)
                            ? "border-amber-400/60 bg-emerald-500/25 text-emerald-100/90 hover:bg-emerald-500/35"
                            : "border-emerald-500/50 bg-emerald-500/25 text-emerald-100/90 hover:bg-emerald-500/35",
                    )}
                    style={{ left: msToPx(cue.startMs), width: w, ...accentStyle }}
                    onPointerDown={(e) => onCuePointerDown(e, cue, "move")}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelCueId(cue.id);
                      select([]);
                      setCueCtx({ x: e.clientX, y: e.clientY, cue });
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setSelCueId(cue.id);
                      setEditCueId(cue.id);
                    }}
                    title={`${cue.text || t("subs.newCueSeed")} · ${timecode(cue.startMs, doc)}–${timecode(cue.endMs, doc)}`}
                  >
                    {cueOverlaps.has(cue.id) && !editing && (
                      <span className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-400" />
                    )}
                    {editing ? (
                      <input
                        autoFocus
                        defaultValue={cue.text}
                        placeholder={t("subs.newCueSeed")}
                        className="absolute left-0 top-0 h-full rounded border border-emerald-300 bg-background px-1.5 text-[10px] text-foreground outline-none"
                        style={{ width: Math.max(180, w) }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") {
                            e.currentTarget.dataset.cancel = "1";
                            e.currentTarget.blur();
                          }
                        }}
                        onBlur={(e) => {
                          if (e.currentTarget.dataset.cancel !== "1")
                            mutate((d) =>
                              updateCue(d, cue.id, { text: e.currentTarget.value }),
                            );
                          setEditCueId(null);
                        }}
                      />
                    ) : (
                      <span className="pointer-events-none block truncate px-1.5">
                        {cue.text || "…"}
                      </span>
                    )}
                    {!editing && (
                      <>
                        {/* Edge handles shrink on narrow cues so the body
                            always keeps a grabbable middle. */}
                        <div
                          className="absolute left-0 top-0 h-full cursor-ew-resize"
                          style={{ width: Math.max(2.5, Math.min(7, w / 4)) }}
                          onPointerDown={(e) => onCuePointerDown(e, cue, "left")}
                        />
                        <div
                          className="absolute right-0 top-0 h-full cursor-ew-resize"
                          style={{ width: Math.max(2.5, Math.min(7, w / 4)) }}
                          onPointerDown={(e) => onCuePointerDown(e, cue, "right")}
                        />
                      </>
                    )}
                  </div>
                );
              })}
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
                              className="flex shrink-0 items-center gap-0.5 rounded-sm bg-amber-400 px-0.5 text-[10px] font-bold text-black"
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
                  const tfx = clipTextFx(clip);
                  const rows = Math.max(
                    1,
                    clip.effects.length + anims.length + (tfx ? 1 : 0),
                  );
                  return Array.from({ length: rows }, (_, i) => {
                    const top = TRACK_H - 2 + i * FX_ROW_H;
                    const fx = i < clip.effects.length ? clip.effects[i] : undefined;
                    const afterFx = i - clip.effects.length;
                    const anim = fx ? undefined : anims[afterFx];
                    const showTfx = !fx && !anim && tfx && afterFx === anims.length;
                    if (showTfx && tfx) {
                      const span = textFxSpan(clip, tfx);
                      const label = `${tfx.kind}${tfx.out ? " out" : ""}`;
                      return (
                        <div
                          key={`${clip.id}-textfx`}
                          className={`absolute flex items-center rounded-sm bg-emerald-400 px-1 text-[8px] font-medium leading-none text-black/80 ${track.locked ? "cursor-not-allowed" : "cursor-ew-resize"}`}
                          style={{
                            left: msToPx(clip.startMs + span.inMs),
                            width: Math.max(6, msToPx(span.outMs - span.inMs)),
                            top,
                            height: FX_ROW_H - 2,
                          }}
                          title={`${label} · ${((span.outMs - span.inMs) / 1000).toFixed(2)}s`}
                          onPointerDown={(e) => onTextFxBarPointerDown(e, track, clip, tfx)}
                        >
                          <span className="truncate">{label}</span>
                        </div>
                      );
                    }
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
                        title={`${effectDef(fx.type)?.label ?? fxEntry(fx.type)?.name ?? fx.type} · ${(inMs / 1000).toFixed(1)}–${(outMs / 1000).toFixed(1)}s`}
                        onPointerDown={(e) => onFxBarPointerDown(e, track, clip, fx)}
                      >
                        <span className="truncate">
                          {effectDef(fx.type)?.label ?? fxEntry(fx.type)?.name ?? fx.type}
                        </span>
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
                      title={`${fxTransition(tr.type)?.name ?? tr.type} · ${(tr.durationMs / 1000).toFixed(2)}s`}
                      onPointerDown={(e) => onTransitionBarPointerDown(e, track, tr)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({ x: e.clientX, y: e.clientY, track, clip: b, transition: tr });
                      }}
                    >
                      <Blend className="mr-0.5 size-2.5 shrink-0" />
                      <span className="truncate">{fxTransition(tr.type)?.name ?? tr.type}</span>
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
                      title={`${fxTransition(tr.type)?.name ?? tr.type} · ${(tr.durationMs / 1000).toFixed(2)}s`}
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

            <PlayheadOverlay msToPx={msToPx} pxToMs={pxToMs} />
          </div>
        </div>
      </div>

      {/* Cue context menu — same affordances as clips, cue-scoped. */}
      <AnchoredMenu
        open={!!cueCtx}
        onClose={() => setCueCtx(null)}
        anchor={cueCtx ? { x: cueCtx.x, y: cueCtx.y } : null}
        side="bottom"
        align="start"
        offset={2}
        className="min-w-44"
      >
        {cueCtx &&
          (() => {
            const ph = playheadNow();
            const inCue = ph > cueCtx.cue.startMs && ph < cueCtx.cue.endMs;
            const cue = cueCtx.cue;
            return (
              <>
                <AnchoredMenuItem
                  onClick={() => {
                    setEditCueId(cue.id);
                    setCueCtx(null);
                  }}
                >
                  <Pencil className="size-3.5" /> {t("subs.editCue")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  disabled={!inCue}
                  onClick={() => {
                    mutate((d) => {
                      const r = splitCue(d, cue.id, playheadNow());
                      if (r) setSelCueId(r.left);
                      return r ? r.doc : d;
                    });
                    setCueCtx(null);
                  }}
                >
                  <Scissors className="size-3.5" /> {t("subs.splitAtPlayhead")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  onClick={() => {
                    mutate((d) => duplicateCue(d, cue.id)?.doc ?? d);
                    setCueCtx(null);
                  }}
                >
                  <CopyPlus className="size-3.5" /> {t("subs.duplicateCue")}
                </AnchoredMenuItem>
                <AnchoredMenuItem
                  disabled={!cue.text.trim()}
                  onClick={() => {
                    mutate((d) => autoTimeWords(d, cue.id));
                    setCueCtx(null);
                  }}
                >
                  <Wand2 className="size-3.5" /> {t("subs.autoTimeOne")}
                </AnchoredMenuItem>
                <AnchoredMenuSeparator />
                {/* Per-cue style: default, saved styles, presets materialized. */}
                <AnchoredMenuItem
                  onClick={() => {
                    mutate((d) => setCueStyle(d, cue.id, null));
                    setCueCtx(null);
                  }}
                >
                  <span className="size-2.5 rounded-full border border-border" />
                  {t("subs.cueStyleDefault")}
                  {!cue.styleId && <Check className="ml-auto size-3" />}
                </AnchoredMenuItem>
                {(doc.subtitleStyles ?? []).map((s) => (
                  <AnchoredMenuItem
                    key={s.id}
                    onClick={() => {
                      mutate((d) => setCueStyle(d, cue.id, s.id));
                      setCueCtx(null);
                    }}
                  >
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: s.style.text.color }}
                    />
                    {s.name}
                    {cue.styleId === s.id && <Check className="ml-auto size-3" />}
                  </AnchoredMenuItem>
                ))}
                {SUBTITLE_PRESETS.map((p) => (
                  <AnchoredMenuItem
                    key={p.id}
                    onClick={() => {
                      mutate((d) => {
                        const r = ensureSubtitleStyle(d, p.label, p.style);
                        return setCueStyle(r.doc, cue.id, r.styleId);
                      });
                      setCueCtx(null);
                    }}
                  >
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: p.style.text.color }}
                    />
                    {p.label}
                  </AnchoredMenuItem>
                ))}
                <AnchoredMenuSeparator />
                <AnchoredMenuItem
                  destructive
                  onClick={() => {
                    mutate((d) => removeCue(d, cue.id));
                    setSelCueId(null);
                    setCueCtx(null);
                  }}
                >
                  <Trash2 className="size-3.5" /> {t("subs.deleteCue")}
                </AnchoredMenuItem>
              </>
            );
          })()}
      </AnchoredMenu>

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
function PlayheadOverlay({
  msToPx,
  pxToMs,
}: {
  msToPx: (ms: number) => number;
  pxToMs: (px: number) => number;
}) {
  const playheadMs = useEditor((s) => s.playheadMs);
  // The line is draggable anywhere along its height — same scrub math as
  // the ruler. The strip is ~9px wide centered on the 1px line.
  const grab = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const col = (e.currentTarget.parentElement as HTMLElement).offsetParent as HTMLElement | null;
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const seek = (ev: { clientX: number }) => {
      const d = useProject.getState().doc;
      if (!d) return;
      useEditor.getState().setPlayhead(
        snapToFrame(Math.max(0, pxToMs(ev.clientX - rect.left)), d),
      );
    };
    seek(e);
    const onMove = (ev: PointerEvent) => seek(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-destructive"
      style={{ left: msToPx(playheadMs) }}
    >
      <div className="absolute -left-1.5 top-0 size-3 rotate-45 bg-destructive" />
      <div
        className="pointer-events-auto absolute inset-y-0 -left-1 w-[9px] cursor-ew-resize"
        onPointerDown={grab}
      />
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
