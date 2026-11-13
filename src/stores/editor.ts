import { create } from "zustand";
import { useProject } from "@/stores/project";
import type { Clip, ProjectDoc, TrackKind } from "@/lib/project-types";

/**
 * Editor session state + undo/redo (ADR-014).
 *
 * Undo is a document snapshot stack: every mutation goes through `mutate()`,
 * which pushes the pre-edit doc onto `past` and clears `future`. Continuous
 * gestures coalesce — `beginGesture()` records one snapshot, subsequent
 * `mutateInGesture` calls mutate freely, `endGesture()` closes the unit.
 * This keeps undo total: any document field — present or future — is
 * restored exactly.
 */

const HISTORY_CAP = 100;

interface EditorState {
  /** Playhead position, ms (session-only, not persisted). */
  playheadMs: number;
  playing: boolean;
  /** Selected clip ids. */
  selection: string[];
  /** Timeline zoom: pixels per second. */
  pxPerSec: number;
  /** Snap toggles (frame snapping is always on; this gates edge/playhead snapping). */
  snapEnabled: boolean;
  /** Clipboard of copied/cut clips (with origin track kind). */
  clipboard: { kind: TrackKind; clip: Clip }[];

  past: ProjectDoc[];
  future: ProjectDoc[];
  /** Non-null during a coalesced gesture (drag/trim). Internal. */
  gestureBase: ProjectDoc | null;

  setPlayhead: (ms: number) => void;
  setPlaying: (p: boolean) => void;
  select: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  setZoom: (pxPerSec: number) => void;
  setSnapEnabled: (v: boolean) => void;
  setClipboard: (entries: { kind: TrackKind; clip: Clip }[]) => void;

  /** Apply an edit: fn receives a doc draft and returns the new doc. */
  mutate: (fn: (doc: ProjectDoc) => ProjectDoc) => void;
  /** Variant for mid-gesture edits — no history push. */
  mutateInGesture: (fn: (doc: ProjectDoc) => ProjectDoc) => void;
  beginGesture: () => void;
  endGesture: () => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  resetHistory: () => void;
}

export const useEditor = create<EditorState>((set, get) => {
  const pushPast = (doc: ProjectDoc) => {
    const past = [...get().past, doc];
    if (past.length > HISTORY_CAP) past.shift();
    set({ past, future: [] });
  };

  return {
    playheadMs: 0,
    playing: false,
    selection: [],
    pxPerSec: 120,
    snapEnabled: true,
    clipboard: [],
    past: [],
    future: [],
    gestureBase: null,

    setPlayhead: (ms) => set({ playheadMs: Math.max(0, ms) }),
    setPlaying: (p) => set({ playing: p }),
    select: (ids) => set({ selection: ids }),
    toggleSelect: (id) =>
      set((s) => ({
        selection: s.selection.includes(id)
          ? s.selection.filter((x) => x !== id)
          : [...s.selection, id],
      })),
    setZoom: (px) => set({ pxPerSec: Math.min(600, Math.max(20, px)) }),
    setSnapEnabled: (v) => set({ snapEnabled: v }),
    setClipboard: (entries) => set({ clipboard: entries }),

    mutate: (fn) => {
      const doc = useProject.getState().doc;
      if (!doc) return;
      const inGesture = get().gestureBase !== null;
      if (!inGesture) pushPast(doc);
      const next = fn(structuredClone(doc));
      useProject.getState().setDoc(next);
    },

    mutateInGesture: (fn) => {
      const doc = useProject.getState().doc;
      if (!doc) return;
      useProject.getState().setDoc(fn(structuredClone(doc)));
    },

    beginGesture: () => {
      const doc = useProject.getState().doc;
      if (!doc || get().gestureBase) return;
      set({ gestureBase: doc });
    },

    endGesture: () => {
      const base = get().gestureBase;
      if (!base) return;
      // Only record history if the gesture actually changed the doc.
      const cur = useProject.getState().doc;
      if (cur && cur !== base) pushPast(base);
      set({ gestureBase: null });
    },

    undo: () => {
      const { past, future } = get();
      const cur = useProject.getState().doc;
      if (!cur || past.length === 0) return;
      const prev = past[past.length - 1];
      set({ past: past.slice(0, -1), future: [...future, cur] });
      useProject.getState().setDoc(structuredClone(prev));
      useProject.getState().markDirty();
    },

    redo: () => {
      const { past, future } = get();
      const cur = useProject.getState().doc;
      if (!cur || future.length === 0) return;
      const next = future[future.length - 1];
      set({ past: [...past, cur], future: future.slice(0, -1) });
      useProject.getState().setDoc(structuredClone(next));
      useProject.getState().markDirty();
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
    resetHistory: () => set({ past: [], future: [], gestureBase: null }),
  };
});
