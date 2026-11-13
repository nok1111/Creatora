/**
 * Timeline engine — pure functions over the `.creatora` document.
 *
 * This module is the frontend mirror of `src-tauri/src/render/plan.rs`:
 * identical segment math so preview and export agree by construction.
 *
 * Time model (ADR-013): persisted times are integer ms; frame snapping is
 * applied at the op layer via msToFrame/frameToMs. Source time for a clip at
 * timeline t = sourceInMs + (t - startMs) * speed.
 */

import type {
  Clip,
  ProjectDoc,
  Timeline,
  Track,
  TrackKind,
  Transform,
} from "@/lib/project-types";

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  cropLeft: 0,
};

// ---------- time ----------

export function fpsOf(doc: ProjectDoc): number {
  return doc.canvas.fpsNum / doc.canvas.fpsDen;
}

/** Frame index for a timeline ms (nearest frame boundary). */
export function msToFrame(ms: number, doc: ProjectDoc): number {
  return Math.round((ms * doc.canvas.fpsNum) / (doc.canvas.fpsDen * 1000));
}

/** Timeline ms of a frame boundary (exact for rational fps). */
export function frameToMs(frame: number, doc: ProjectDoc): number {
  return Math.round((frame * doc.canvas.fpsDen * 1000) / doc.canvas.fpsNum);
}

/** Snap a ms value to the nearest frame boundary. */
export function snapToFrame(ms: number, doc: ProjectDoc): number {
  return frameToMs(msToFrame(ms, doc), doc);
}

/** `HH:MM:SS:FF` timecode at project fps. */
export function timecode(ms: number, doc: ProjectDoc): string {
  const f = msToFrame(ms, doc);
  const fps = Math.round(fpsOf(doc));
  const s = Math.floor(f / fps);
  const ff = f % fps;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

// ---------- queries ----------

/** End of the last clip across tracks — the export duration. */
export function timelineDuration(doc: ProjectDoc): number {
  let end = 0;
  for (const t of doc.timeline.tracks)
    for (const c of t.clips) end = Math.max(end, c.startMs + c.durationMs);
  return end;
}

export interface ActiveClip {
  track: Track;
  clip: Clip;
  /** Source-media time (ms) feeding the preview/renderer at this moment. */
  sourceMs: number;
}

/** Clips visible/audible at timeline time `tMs`, in track order (z ascending). */
export function activeClipsAt(doc: ProjectDoc, tMs: number): ActiveClip[] {
  const out: ActiveClip[] = [];
  for (const track of doc.timeline.tracks) {
    for (const clip of track.clips) {
      if (tMs >= clip.startMs && tMs < clip.startMs + clip.durationMs) {
        out.push({
          track,
          clip,
          sourceMs: clip.sourceInMs + (tMs - clip.startMs) * clip.speed,
        });
      }
    }
  }
  return out;
}

export function findClip(doc: ProjectDoc, clipId: string): { track: Track; clip: Clip } | null {
  for (const t of doc.timeline.tracks)
    for (const c of t.clips) if (c.id === clipId) return { track: t, clip: c };
  return null;
}

/**
 * Canvas rect for a clip — the SAME math the render plan encodes as
 * `overlay=x:y`: source fitted into canvas (aspect preserved, letterboxed),
 * then scaled by transform.scale, centered, offset by transform.x/y pixels.
 */
export function clipRect(
  doc: ProjectDoc,
  clip: Clip,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  const { width: W, height: H } = doc.canvas;
  const t = clip.transform;
  // Crop shrinks the fitted box by fractions of each side.
  const fit = Math.min(W / srcW, H / srcH);
  let w = srcW * fit;
  let h = srcH * fit;
  w *= 1 - t.cropLeft - t.cropRight;
  h *= 1 - t.cropTop - t.cropBottom;
  w *= t.scaleX;
  h *= t.scaleY;
  return {
    x: (W - w) / 2 + t.x,
    y: (H - h) / 2 + t.y,
    w,
    h,
  };
}

// ---------- structural helpers (immutable updates) ----------

function cloneDoc(doc: ProjectDoc): ProjectDoc {
  return structuredClone(doc);
}

function uid(): string {
  return crypto.randomUUID();
}

export function ensureTrack(doc: Timeline, kind: TrackKind, name: string): Track {
  const existing = doc.tracks.find((t) => t.kind === kind);
  if (existing) return existing;
  const t: Track = {
    id: uid(),
    kind,
    name,
    clips: [],
    locked: false,
    visible: true,
    muted: false,
  };
  doc.tracks.push(t);
  return t;
}

// ---------- editing ops (pure: doc in → new doc out) ----------

/** Insert a clip onto a track, snapped to frames. Returns clip id. */
export function addClip(
  doc: ProjectDoc,
  opts: {
    trackKind?: TrackKind;
    mediaRef: string;
    startMs: number;
    durationMs: number;
    sourceInMs?: number;
    name?: string;
  },
): { doc: ProjectDoc; clipId: string } {
  const next = cloneDoc(doc);
  const kind = opts.trackKind ?? "video";
  const track = ensureTrack(
    next.timeline,
    kind,
    kind === "video" ? "V1" : kind === "audio" ? "A1" : "T1",
  );
  const c: Clip = {
    id: uid(),
    mediaRef: opts.mediaRef,
    startMs: Math.max(0, snapToFrame(opts.startMs, doc)),
    durationMs: Math.max(1, snapToFrame(opts.durationMs, doc)),
    sourceInMs: Math.max(0, opts.sourceInMs ?? 0),
    sourceOutMs: null,
    transform: { ...DEFAULT_TRANSFORM },
    effects: [],
    volume: 1,
    speed: 1,
    text: null,
    keyframes: {},
  };
  track.clips.push(c);
  track.clips.sort((a, b) => a.startMs - b.startMs);
  return { doc: next, clipId: c.id };
}

/** Move a clip along the timeline (frame-snapped, clamped ≥ 0). */
export function moveClip(doc: ProjectDoc, clipId: string, newStartMs: number): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  hit.clip.startMs = Math.max(0, snapToFrame(newStartMs, next));
  hit.track.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

export type TrimEdge = "start" | "end";

/**
 * Trim a clip edge (non-destructive — moves sourceIn/duration, never media).
 * start edge: startMs advances and sourceInMs consumes the removed range.
 * end edge: only durationMs changes. Result is frame-snapped, ≥ 1 frame.
 */
export function trimClip(
  doc: ProjectDoc,
  clipId: string,
  edge: TrimEdge,
  deltaMs: number,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  const { clip } = hit;
  const frame = frameToMs(1, next);
  if (edge === "end") {
    clip.durationMs = Math.max(frame, snapToFrame(clip.durationMs + deltaMs, next));
  } else {
    const d = snapToFrame(deltaMs, next);
    const maxShift = clip.durationMs - frame; // keep ≥1 frame
    const applied = Math.min(Math.max(d, -clip.startMs), maxShift);
    clip.startMs += applied;
    clip.durationMs -= applied;
    clip.sourceInMs += Math.round(applied * clip.speed);
  }
  return next;
}

/**
 * Split a clip at absolute timeline time `atMs`. The right half becomes a
 * new clip (new id) starting at the cut, with sourceIn advanced.
 * Returns {doc, rightClipId} or null when `atMs` isn't strictly inside.
 */
export function splitClip(
  doc: ProjectDoc,
  clipId: string,
  atMs: number,
): { doc: ProjectDoc; rightClipId: string } | null {
  const at = snapToFrame(atMs, doc);
  const found = findClip(doc, clipId);
  if (!found) return null;
  const { clip } = found;
  const end = clip.startMs + clip.durationMs;
  if (at <= clip.startMs || at >= end) return null;

  const next = cloneDoc(doc);
  const { track, clip: left } = findClip(next, clipId)!;
  const leftDur = at - left.startMs;
  const right: Clip = {
    ...structuredClone(left),
    id: uid(),
    startMs: at,
    durationMs: left.durationMs - leftDur,
    sourceInMs: left.sourceInMs + Math.round(leftDur * left.speed),
  };
  left.durationMs = leftDur;
  track.clips.push(right);
  track.clips.sort((a, b) => a.startMs - b.startMs);
  return { doc: next, rightClipId: right.id };
}

export function removeClip(doc: ProjectDoc, clipId: string): ProjectDoc {
  const next = cloneDoc(doc);
  for (const t of next.timeline.tracks) {
    const i = t.clips.findIndex((c) => c.id === clipId);
    if (i >= 0) {
      t.clips.splice(i, 1);
      return next;
    }
  }
  return next;
}

/** Patch clip properties (volume, transform fields, …) immutably. */
export function updateClip(
  doc: ProjectDoc,
  clipId: string,
  patch: Partial<Pick<Clip, "volume" | "speed" | "text">> & {
    transform?: Partial<Transform>;
  },
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  const { transform, ...rest } = patch;
  Object.assign(hit.clip, rest);
  if (transform) Object.assign(hit.clip.transform, transform);
  return next;
}

/** Frame-snapped candidate start times: playhead + every clip edge. */
export function snapPoints(doc: ProjectDoc, playheadMs: number): number[] {
  const pts = new Set<number>([snapToFrame(playheadMs, doc)]);
  for (const t of doc.timeline.tracks)
    for (const c of t.clips) {
      pts.add(c.startMs);
      pts.add(c.startMs + c.durationMs);
    }
  return [...pts].sort((a, b) => a - b);
}
