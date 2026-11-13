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
  Effect,
  ProjectDoc,
  Timeline,
  Track,
  TrackKind,
  TextStyle,
  Transform,
  Transition,
} from "@/lib/project-types";
import { DEFAULT_TEXT_STYLE } from "@/lib/project-types";

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
    transitions: [],
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
    /** Full source-media duration (for trim clamping). */
    sourceDurationMs?: number | null;
    /** Target track id — falls back to first track of `trackKind`. */
    trackId?: string;
  },
): { doc: ProjectDoc; clipId: string } {
  const next = cloneDoc(doc);
  const kind = opts.trackKind ?? "video";
  const track =
    (opts.trackId
      ? next.timeline.tracks.find((t) => t.id === opts.trackId)
      : undefined) ??
    ensureTrack(
      next.timeline,
      kind,
      kind === "video" ? "V1" : kind === "audio" ? "A1" : "T1",
    );
  if (track.locked) return { doc: next, clipId: "" };
  const c: Clip = {
    id: uid(),
    mediaRef: opts.mediaRef,
    startMs: Math.max(0, snapToFrame(opts.startMs, doc)),
    durationMs: Math.max(1, snapToFrame(opts.durationMs, doc)),
    sourceInMs: Math.max(0, opts.sourceInMs ?? 0),
    sourceOutMs: null,
    sourceDurationMs: opts.sourceDurationMs ?? null,
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

/** Text clip on a text track — no media ref; canonical style applied. */
export function addTextClip(
  doc: ProjectDoc,
  opts: {
    text: string;
    startMs: number;
    durationMs: number;
    style?: Partial<TextStyle>;
    trackId?: string;
  },
): { doc: ProjectDoc; clipId: string } {
  const next = cloneDoc(doc);
  const track =
    (opts.trackId
      ? next.timeline.tracks.find((t) => t.id === opts.trackId)
      : undefined) ?? ensureTrack(next.timeline, "text", "T1");
  if (track.locked) return { doc: next, clipId: "" };
  const c: Clip = {
    id: uid(),
    mediaRef: null,
    startMs: Math.max(0, snapToFrame(opts.startMs, doc)),
    durationMs: Math.max(1, snapToFrame(opts.durationMs, doc)),
    sourceInMs: 0,
    sourceOutMs: null,
    sourceDurationMs: null,
    transform: { ...DEFAULT_TRANSFORM },
    effects: [],
    volume: 1,
    speed: 1,
    text: opts.text,
    textStyle: { ...DEFAULT_TEXT_STYLE, ...opts.style },
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
  if (!hit || hit.track.locked) return next;
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
  if (!hit || hit.track.locked) return next;
  const { clip } = hit;
  const frame = frameToMs(1, next);
  if (edge === "end") {
    let d = Math.max(frame, snapToFrame(clip.durationMs + deltaMs, next));
    // Never extend past the end of the source media (when known): an
    // over-long doc clip would export shorter than the timeline shows.
    if (clip.sourceDurationMs != null && clip.speed > 0) {
      const maxDur = Math.floor(
        (clip.sourceDurationMs - clip.sourceInMs) / clip.speed,
      );
      if (maxDur > 0) d = Math.min(d, Math.max(frame, maxDur));
    }
    clip.durationMs = d;
  } else {
    const d = snapToFrame(deltaMs, next);
    const maxShift = clip.durationMs - frame; // keep ≥1 frame
    // Lower bound: can't reveal media before sourceIn 0 (or before t=0).
    const minShift = Math.max(-clip.startMs, -(clip.sourceInMs / clip.speed));
    const applied = Math.min(Math.max(d, minShift), maxShift);
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
  if (!found || found.track.locked) return null;
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
    keyframes: {},
  };
  // Keyframes are clip-relative: the right half keeps only samples at/after
  // the cut, shifted to its own origin. Samples exactly at the cut keep the
  // animation continuous on both sides.
  for (const [path, kfs] of Object.entries(left.keyframes)) {
    const before = kfs.filter((k) => k.tMs <= leftDur);
    const after = kfs
      .filter((k) => k.tMs >= leftDur)
      .map((k) => ({ ...k, tMs: k.tMs - leftDur }));
    if (before.length) left.keyframes[path] = before;
    else delete left.keyframes[path];
    if (after.length) right.keyframes[path] = after;
  }
  left.durationMs = leftDur;
  track.clips.push(right);
  track.clips.sort((a, b) => a.startMs - b.startMs);
  // Transitions: the outgoing fade lives at the clip's TAIL → after a split
  // it belongs to the right half. clipB (head fade) stays on the left.
  for (const tr of track.transitions) {
    if (tr.clipA === left.id) tr.clipA = right.id;
  }
  return { doc: next, rightClipId: right.id };
}

export function removeClip(doc: ProjectDoc, clipId: string): ProjectDoc {
  const next = cloneDoc(doc);
  for (const t of next.timeline.tracks) {
    if (t.locked) continue;
    const i = t.clips.findIndex((c) => c.id === clipId);
    if (i >= 0) {
      t.clips.splice(i, 1);
      t.transitions = t.transitions.filter(
        (tr) => tr.clipA !== clipId && tr.clipB !== clipId,
      );
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
  if (!hit || hit.track.locked) return next;
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

// ---------- track ops ----------

const TRACK_NAMES: Record<TrackKind, string> = {
  video: "V",
  audio: "A",
  image: "I",
  text: "T",
  graphics: "G",
};

/** Append a track of `kind`; auto-names it (V1, V2, … / A1, A2, …). */
export function addTrack(doc: ProjectDoc, kind: TrackKind): { doc: ProjectDoc; trackId: string } {
  const next = cloneDoc(doc);
  const n = next.timeline.tracks.filter((t) => t.kind === kind).length + 1;
  const t: Track = {
    id: uid(),
    kind,
    name: `${TRACK_NAMES[kind]}${n}`,
    clips: [],
    transitions: [],
    locked: false,
    visible: true,
    muted: false,
  };
  next.timeline.tracks.push(t);
  return { doc: next, trackId: t.id };
}

/** Remove a track and its clips. */
export function removeTrack(doc: ProjectDoc, trackId: string): ProjectDoc {
  const next = cloneDoc(doc);
  next.timeline.tracks = next.timeline.tracks.filter((t) => t.id !== trackId);
  return next;
}

export function renameTrack(doc: ProjectDoc, trackId: string, name: string): ProjectDoc {
  const next = cloneDoc(doc);
  const t = next.timeline.tracks.find((x) => x.id === trackId);
  if (t && name.trim()) t.name = name.trim();
  return next;
}

export function setTrackFlag(
  doc: ProjectDoc,
  trackId: string,
  flags: Partial<Pick<Track, "locked" | "visible" | "muted">>,
): ProjectDoc {
  const next = cloneDoc(doc);
  const t = next.timeline.tracks.find((x) => x.id === trackId);
  if (t) Object.assign(t, flags);
  return next;
}

/** Move a track one position in stacking order (dir = -1 toward bottom / +1 toward top). */
export function moveTrackOrder(doc: ProjectDoc, trackId: string, dir: -1 | 1): ProjectDoc {
  const next = cloneDoc(doc);
  const i = next.timeline.tracks.findIndex((t) => t.id === trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= next.timeline.tracks.length) return next;
  const [t] = next.timeline.tracks.splice(i, 1);
  next.timeline.tracks.splice(j, 0, t);
  return next;
}

// ---------- batch / clipboard ops ----------

/** Move several clips by the same delta (frame-snapped via the anchor clip). */
export function moveClips(
  doc: ProjectDoc,
  clipIds: string[],
  deltaMs: number,
): ProjectDoc {
  const next = cloneDoc(doc);
  for (const id of clipIds) {
    const hit = findClip(next, id);
    if (!hit || hit.track.locked) continue;
    hit.clip.startMs = Math.max(0, snapToFrame(hit.clip.startMs + deltaMs, next));
  }
  for (const t of next.timeline.tracks) t.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

/** Deep copies of clips for clipboard — carries their source track kind. */
export function extractClips(
  doc: ProjectDoc,
  clipIds: string[],
): { kind: TrackKind; clip: Clip }[] {
  const out: { kind: TrackKind; clip: Clip }[] = [];
  for (const t of doc.timeline.tracks)
    for (const c of t.clips)
      if (clipIds.includes(c.id)) out.push({ kind: t.kind, clip: structuredClone(c) });
  return out;
}

/**
 * Paste clipboard entries at `atMs`, preserving relative offsets. Each entry
 * lands on the first unlocked track of its original kind (created if absent).
 * Returns new clip ids for selection.
 */
export function pasteClips(
  doc: ProjectDoc,
  entries: { kind: TrackKind; clip: Clip }[],
  atMs: number,
): { doc: ProjectDoc; clipIds: string[] } {
  const next = cloneDoc(doc);
  if (entries.length === 0) return { doc: next, clipIds: [] };
  const at = snapToFrame(atMs, next);
  const min = Math.min(...entries.map((e) => e.clip.startMs));
  const ids: string[] = [];
  for (const e of entries) {
    const track =
      next.timeline.tracks.find((t) => t.kind === e.kind && !t.locked) ??
      ensureTrack(next.timeline, e.kind, `${TRACK_NAMES[e.kind]}${next.timeline.tracks.filter((t) => t.kind === e.kind).length + 1}`);
    const c: Clip = {
      ...structuredClone(e.clip),
      id: uid(),
      startMs: Math.max(0, at + (e.clip.startMs - min)),
    };
    track.clips.push(c);
    track.clips.sort((a, b) => a.startMs - b.startMs);
    ids.push(c.id);
  }
  return { doc: next, clipIds: ids };
}

/** Duplicate clips in place: copies offset to end of each clip. */
export function duplicateClips(
  doc: ProjectDoc,
  clipIds: string[],
): { doc: ProjectDoc; clipIds: string[] } {
  const next = cloneDoc(doc);
  const ids: string[] = [];
  for (const t of next.timeline.tracks) {
    const copies: Clip[] = [];
    for (const c of t.clips) {
      if (!clipIds.includes(c.id) || t.locked) continue;
      const copy: Clip = {
        ...structuredClone(c),
        id: uid(),
        startMs: c.startMs + c.durationMs,
      };
      copies.push(copy);
      ids.push(copy.id);
    }
    t.clips.push(...copies);
    t.clips.sort((a, b) => a.startMs - b.startMs);
  }
  return { doc: next, clipIds: ids };
}

/** Remove clips on unlocked tracks only; returns removed count. */
export function removeClips(doc: ProjectDoc, clipIds: string[]): { doc: ProjectDoc; removed: number } {
  const next = cloneDoc(doc);
  let removed = 0;
  for (const t of next.timeline.tracks) {
    if (t.locked) continue;
    const before = t.clips.length;
    t.clips = t.clips.filter((c) => !clipIds.includes(c.id));
    removed += before - t.clips.length;
    t.transitions = t.transitions.filter(
      (tr) => !clipIds.includes(tr.clipA) && !clipIds.includes(tr.clipB),
    );
  }
  return { doc: next, removed };
}

/**
 * Move a clip to a different track (same kind) at `startMs`.
 * Transitions are per-track — the clip's transition links are dropped on
 * the source track (they cannot span tracks).
 */
export function moveClipToTrack(
  doc: ProjectDoc,
  clipId: string,
  targetTrackId: string,
  startMs: number,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  const target = next.timeline.tracks.find((t) => t.id === targetTrackId);
  if (!hit || !target || hit.track.locked || target.locked) return next;
  if (hit.track.id === target.id) {
    return moveClip(next, clipId, startMs);
  }
  // Kind compatibility: video/image clips land on video tracks, audio on
  // audio tracks. Never mix.
  const wantVideo = hit.track.kind !== "audio";
  if ((target.kind === "audio") === wantVideo) return next;
  hit.track.clips = hit.track.clips.filter((c) => c.id !== clipId);
  hit.track.transitions = hit.track.transitions.filter(
    (tr) => tr.clipA !== clipId && tr.clipB !== clipId,
  );
  hit.clip.startMs = Math.max(0, snapToFrame(startMs, next));
  target.clips.push(hit.clip);
  target.clips.sort((a, b) => a.startMs - b.startMs);
  return next;
}

// ---------- effects / keyframes / transitions ----------

/** Append an effect to a clip's stack. */
export function addEffect(doc: ProjectDoc, clipId: string, effect: Effect): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  hit.clip.effects.push(effect);
  return next;
}

export function removeEffect(doc: ProjectDoc, clipId: string, effectId: string): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  hit.clip.effects = hit.clip.effects.filter((e) => e.id !== effectId);
  return next;
}

export function updateEffect(
  doc: ProjectDoc,
  clipId: string,
  effectId: string,
  patch: Partial<Pick<Effect, "enabled">> & { params?: Record<string, number> },
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const fx = hit.clip.effects.find((e) => e.id === effectId);
  if (!fx) return next;
  if (patch.enabled !== undefined) fx.enabled = patch.enabled;
  if (patch.params) Object.assign(fx.params, patch.params);
  return next;
}

/** Insert/replace a keyframe on `path` at clip-relative `tMs` with `v`. */
export function setKeyframe(
  doc: ProjectDoc,
  clipId: string,
  path: string,
  tMs: number,
  v: number,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const t = Math.max(0, Math.min(hit.clip.durationMs, Math.round(tMs)));
  const list = (hit.clip.keyframes[path] ??= []);
  const existing = list.find((k) => k.tMs === t);
  if (existing) {
    existing.v = v;
  } else {
    list.push({ tMs: t, v, ease: "linear" });
    list.sort((a, b) => a.tMs - b.tMs);
  }
  return next;
}

export function removeKeyframe(
  doc: ProjectDoc,
  clipId: string,
  path: string,
  tMs: number,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const list = hit.clip.keyframes[path];
  if (!list) return next;
  hit.clip.keyframes[path] = list.filter((k) => k.tMs !== Math.round(tMs));
  if (hit.clip.keyframes[path].length === 0) delete hit.clip.keyframes[path];
  return next;
}

/**
 * Create a transition between two adjacent clips on a track.
 * The incoming clip is shifted so `clipB.startMs = clipA.end - durationMs`
 * (transitions consume overlap — see ADR-015 and Track.transitions).
 */
export function addTransition(
  doc: ProjectDoc,
  trackId: string,
  clipAId: string,
  clipBId: string,
  durationMs: number,
  kind = "crossfade",
): { doc: ProjectDoc; transitionId: string } | null {
  const track = doc.timeline.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return null;
  const a = track.clips.find((c) => c.id === clipAId);
  const b = track.clips.find((c) => c.id === clipBId);
  if (!a || !b || a === b) return null;
  const aEnd = a.startMs + a.durationMs;
  const d = Math.max(1, Math.min(durationMs, a.durationMs - 1, b.durationMs - 1));
  if (d <= 0) return null;

  const next = cloneDoc(doc);
  const nt = next.timeline.tracks.find((t) => t.id === trackId)!;
  const nb = nt.clips.find((c) => c.id === clipBId)!;
  // Align: B overlaps A's tail by exactly d ms.
  nb.startMs = snapToFrame(aEnd - d, next);
  const overlap = aEnd - nb.startMs;
  const tr: Transition = {
    id: uid(),
    type: kind,
    durationMs: overlap,
    clipA: clipAId,
    clipB: clipBId,
  };
  nt.transitions.push(tr);
  nt.clips.sort((x, y) => x.startMs - y.startMs);
  return { doc: next, transitionId: tr.id };
}

export function removeTransition(doc: ProjectDoc, trackId: string, transitionId: string): ProjectDoc {
  const next = cloneDoc(doc);
  const t = next.timeline.tracks.find((x) => x.id === trackId);
  if (t && !t.locked) t.transitions = t.transitions.filter((x) => x.id !== transitionId);
  return next;
}

/** Transitions involving a clip (for opacity evaluation in preview). */
export function transitionsFor(doc: ProjectDoc, clipId: string): Transition[] {
  return doc.timeline.tracks
    .flatMap((t) => t.transitions)
    .filter((tr) => tr.clipA === clipId || tr.clipB === clipId);
}

/**
 * Opacity factor a transition applies to `clipId` at absolute `tMs`.
 * crossfade: linear alpha over the overlap; dipToBlack: alpha to black.
 */
export function transitionAlpha(doc: ProjectDoc, clipId: string, tMs: number): number {
  let alpha = 1;
  for (const tr of transitionsFor(doc, clipId)) {
    const a = findClip(doc, tr.clipA)?.clip;
    const b = findClip(doc, tr.clipB)?.clip;
    if (!a || !b) continue;
    const overlapStart = b.startMs;
    const overlapEnd = Math.min(a.startMs + a.durationMs, overlapStart + tr.durationMs);
    if (tMs < overlapStart || tMs >= overlapEnd || tr.durationMs <= 0) continue;
    const u = (tMs - overlapStart) / tr.durationMs;
    if (tr.type === "dipToBlack" || tr.type === "dipToWhite") {
      // Half-fade each side: A→black for first half, black→B for second.
      const half = u * 2;
      alpha *= clipId === tr.clipA ? Math.max(0, 1 - half) : Math.max(0, half - 1);
    } else {
      alpha *= clipId === tr.clipA ? 1 - u : u;
    }
  }
  return alpha;
}
