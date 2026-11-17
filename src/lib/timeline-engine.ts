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

import { FX_MANIFEST, defaultParams, fxTransition, validateParams } from "@/lib/fx/manifest";
import { animPreset, supportsTextFx } from "@/lib/anim-presets";
import type {
  Clip,
  Effect,
  ProjectDoc,
  Timeline,
  Track,
  TrackKind,
  ClipOverride,
  FormatVersion,
  DuckingRule,
  SubtitleCue,
  SubtitleStyle,
  TextStyle,
  Transform,
  Transition,
  Keyframe,
  TextFx,
} from "@/lib/project-types";
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_TEXT_STYLE } from "@/lib/project-types";

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
    volume: 1,
    solo: false,
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
    pan: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
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
    pan: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
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
  patch: Partial<Pick<Clip, "volume" | "speed" | "text" | "textStyle" | "pan" | "fadeInMs" | "fadeOutMs" | "shape" | "textFx" | "hidden" | "brandBindings">> & {
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
    volume: 1,
    solo: false,
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
  flags: Partial<Pick<Track, "locked" | "visible" | "muted" | "volume" | "solo">>,
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

/** Move an effect one slot within its clip's stack (order matters:
    filters and effect fragments apply in array order). */
export function moveEffect(
  doc: ProjectDoc,
  clipId: string,
  effectId: string,
  dir: -1 | 1,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const i = hit.clip.effects.findIndex((e) => e.id === effectId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= hit.clip.effects.length) return next;
  const [fx] = hit.clip.effects.splice(i, 1);
  hit.clip.effects.splice(j, 0, fx);
  return next;
}

export function updateEffect(
  doc: ProjectDoc,
  clipId: string,
  effectId: string,
  patch: Partial<Pick<Effect, "enabled" | "inMs" | "outMs" | "file" | "times">> & { params?: Record<string, number> },
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const fx = hit.clip.effects.find((e) => e.id === effectId);
  if (!fx) return next;
  if (patch.enabled !== undefined) fx.enabled = patch.enabled;
  // Effect windows are clip-relative — clamp into the clip bounds.
  const clampT = (t: number) => Math.max(0, Math.min(hit.clip.durationMs, t));
  if (patch.inMs !== undefined) fx.inMs = clampT(patch.inMs);
  if (patch.outMs !== undefined) fx.outMs = clampT(patch.outMs);
  if (fx.inMs !== undefined && fx.outMs !== undefined && fx.outMs <= fx.inMs)
    fx.outMs = Math.min(hit.clip.durationMs, fx.inMs + 50);
  if (patch.params) Object.assign(fx.params, patch.params);
  if (patch.file !== undefined) fx.file = patch.file;
  if (patch.times !== undefined) fx.times = patch.times;
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

/** Shift every clip that starts at/after `fromStart` (except `moved`) by
 *  `delta` ms — keeps the rest of the track's junctions intact. */
function rippleAfter(clips: Clip[], moved: Clip, fromStart: number, delta: number) {
  if (!delta) return;
  for (const c of clips) if (c !== moved && c.startMs >= fromStart) c.startMs += delta;
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
  opts?: { params?: Record<string, number>; ease?: string },
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
  // Align: B overlaps A's tail by exactly d ms; everything after B on the
  // track ripples by the same delta so later junctions keep their overlaps
  // (and stay adjacent for the next transition).
  const oldBStart = nb.startMs;
  nb.startMs = snapToFrame(aEnd - d, next);
  rippleAfter(nt.clips, nb, oldBStart, nb.startMs - oldBStart);
  const overlap = aEnd - nb.startMs;
  const tr: Transition = {
    id: uid(),
    type: kind,
    durationMs: overlap,
    clipA: clipAId,
    clipB: clipBId,
  };
  // Library transitions (shared/fx manifest) start from validated params.
  const lib = fxTransition(kind);
  if (lib) {
    tr.params = validateParams(lib, opts?.params ?? defaultParams(lib)).params;
    if (opts?.ease && FX_MANIFEST.eases[opts.ease]) tr.ease = opts.ease;
  }
  // One transition per junction: re-applying replaces the existing one
  // (otherwise two transitions stack on the same pair and the preview/render
  // disagree about which one plays).
  nt.transitions = nt.transitions.filter((x) => !(x.clipA === clipAId && x.clipB === clipBId));
  nt.transitions.push(tr);
  nt.clips.sort((x, y) => x.startMs - y.startMs);
  return { doc: next, transitionId: tr.id };
}

/** Re-size an existing transition: re-aligns B so it overlaps A's tail by
 *  exactly `durationMs` (clamped to both clip lengths). */
export function setTransitionDuration(
  doc: ProjectDoc,
  trackId: string,
  transitionId: string,
  durationMs: number,
): ProjectDoc {
  const track = doc.timeline.tracks.find((t) => t.id === trackId);
  const tr = track?.transitions.find((x) => x.id === transitionId);
  if (!track || !tr || track.locked) return doc;
  const a = track.clips.find((c) => c.id === tr.clipA);
  const b = track.clips.find((c) => c.id === tr.clipB);
  if (!a || !b) return doc;
  const d = Math.max(1, Math.min(durationMs, a.durationMs - 1, b.durationMs - 1));
  if (d <= 0) return doc;
  const next = cloneDoc(doc);
  const nt = next.timeline.tracks.find((t) => t.id === trackId)!;
  const nb = nt.clips.find((c) => c.id === tr.clipB)!;
  const ntr = nt.transitions.find((x) => x.id === transitionId)!;
  const oldBStart = nb.startMs;
  nb.startMs = snapToFrame(a.startMs + a.durationMs - d, next);
  rippleAfter(nt.clips, nb, oldBStart, nb.startMs - oldBStart);
  ntr.durationMs = d;
  nt.clips.sort((x, y) => x.startMs - y.startMs);
  return next;
}

/** Patch a library transition's params/ease (validated against the manifest). */
export function updateTransition(
  doc: ProjectDoc,
  trackId: string,
  transitionId: string,
  patch: { params?: Record<string, number>; ease?: string },
): ProjectDoc {
  const next = cloneDoc(doc);
  const t = next.timeline.tracks.find((x) => x.id === trackId);
  const tr = t?.transitions.find((x) => x.id === transitionId);
  if (!t || !tr || t.locked) return next;
  const lib = fxTransition(tr.type);
  if (!lib) return next;
  if (patch.params) tr.params = validateParams(lib, { ...(tr.params ?? {}), ...patch.params }).params;
  if (patch.ease !== undefined) {
    if (FX_MANIFEST.eases[patch.ease]) tr.ease = patch.ease;
    else delete tr.ease;
  }
  return next;
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

// ---------- format versions (ADR-021) ----------

/**
 * Merge a version over the doc → what preview/render see.
 * Mirror of document.rs::apply_version — MUST stay identical.
 */
export function applyVersion(doc: ProjectDoc, versionId: string): ProjectDoc | null {
  const v = doc.versions.find((x) => x.id === versionId);
  if (!v) return null;
  const d = cloneDoc(doc);
  d.canvas = { ...v.canvas };
  d.versions = [];
  if (v.subtitleStyle) d.subtitleStyle = { ...v.subtitleStyle };
  for (const track of d.timeline.tracks) {
    for (const clip of track.clips) {
      const ov = v.clipOverrides[clip.id];
      if (!ov) continue;
      if (ov.transform) clip.transform = { ...ov.transform };
      if (ov.keyframes) {
        for (const [path, kfs] of Object.entries(ov.keyframes)) {
          clip.keyframes[path] = kfs.map((k) => ({ ...k }));
        }
      }
      if (ov.textStyle) clip.textStyle = { ...ov.textStyle };
      if (ov.text !== undefined) clip.text = ov.text;
      if (ov.hidden !== undefined) clip.hidden = ov.hidden;
      if (ov.textFx !== undefined) clip.textFx = ov.textFx ? { ...ov.textFx } : null;
    }
  }
  return d;
}

/** The doc the UI/export should use for `versionId` (null → base). */
export function effectiveDoc(doc: ProjectDoc, versionId: string | null): ProjectDoc {
  return versionId ? (applyVersion(doc, versionId) ?? doc) : doc;
}

export function addVersion(
  doc: ProjectDoc,
  opts: { name: string; canvas: Canvas; presetId?: string; safeZones?: SafeZones },
): { doc: ProjectDoc; versionId: string } {
  const next = cloneDoc(doc);
  const v: FormatVersion = {
    id: uid(),
    name: opts.name,
    presetId: opts.presetId ?? null,
    canvas: { ...opts.canvas },
    safeZones: opts.safeZones ?? { top: 0, bottom: 0, left: 0, right: 0 },
    clipOverrides: {},
    export: { ...DEFAULT_EXPORT_SETTINGS },
  };
  next.versions.push(v);
  return { doc: next, versionId: v.id };
}

export function removeVersion(doc: ProjectDoc, versionId: string): ProjectDoc {
  const next = cloneDoc(doc);
  next.versions = next.versions.filter((v) => v.id !== versionId);
  return next;
}

export function renameVersion(doc: ProjectDoc, versionId: string, name: string): ProjectDoc {
  const next = cloneDoc(doc);
  const v = next.versions.find((x) => x.id === versionId);
  if (v) v.name = name;
  return next;
}

export function duplicateVersion(doc: ProjectDoc, versionId: string): { doc: ProjectDoc; versionId: string | null } {
  const src = doc.versions.find((x) => x.id === versionId);
  if (!src) return { doc, versionId: null };
  const next = cloneDoc(doc);
  const copy: FormatVersion = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.name = `${src.name} copy`;
  next.versions.push(copy);
  return { doc: next, versionId: copy.id };
}

/** Reset a version's overrides to empty (keeps canvas/name/preset). */
export function resetVersion(doc: ProjectDoc, versionId: string): ProjectDoc {
  const next = cloneDoc(doc);
  const v = next.versions.find((x) => x.id === versionId);
  if (v) v.clipOverrides = {};
  return next;
}

/**
 * Write a reframe override for a clip in a version — the ONLY legitimate
 * per-version mutation (transform / keyframe paths / textStyle).
 */
export function setVersionClipOverride(
  doc: ProjectDoc,
  versionId: string,
  clipId: string,
  ov: ClipOverride,
): ProjectDoc {
  const next = cloneDoc(doc);
  const v = next.versions.find((x) => x.id === versionId);
  if (!v) return next;
  const cur = v.clipOverrides[clipId] ?? {};
  v.clipOverrides[clipId] = { ...cur, ...ov };
  return next;
}

export function getVersion(doc: ProjectDoc, versionId: string): FormatVersion | undefined {
  return doc.versions.find((v) => v.id === versionId);
}


// ---------- subtitle cues (ADR-025) ----------

export function updateCue(doc: ProjectDoc, cueId: string, patch: Partial<SubtitleCue>): ProjectDoc {
  const next = cloneDoc(doc);
  const c = next.subtitles.find((x) => x.id === cueId);
  if (!c) return next;
  Object.assign(c, patch);
  if (c.endMs <= c.startMs) c.endMs = c.startMs + 1;
  return next;
}

export function addCue(doc: ProjectDoc, cue: Omit<SubtitleCue, "id">): { doc: ProjectDoc; cueId: string } {
  const next = cloneDoc(doc);
  const c: SubtitleCue = { ...cue, id: uid(), words: cue.words ?? [] };
  next.subtitles.push(c);
  next.subtitles.sort((a, b) => a.startMs - b.startMs);
  return { doc: next, cueId: c.id };
}

export function removeCue(doc: ProjectDoc, cueId: string): ProjectDoc {
  const next = cloneDoc(doc);
  next.subtitles = next.subtitles.filter((c) => c.id !== cueId);
  return next;
}

export function duplicateCue(doc: ProjectDoc, cueId: string): { doc: ProjectDoc; cueId: string } | null {
  const c = doc.subtitles.find((x) => x.id === cueId);
  if (!c) return null;
  const dur = c.endMs - c.startMs;
  return addCue(doc, { ...c, startMs: c.endMs, endMs: c.endMs + dur, words: c.words.map((w) => ({ ...w })) });
}

/** Split at atMs (cue-relative text split at nearest word boundary or midpoint). */
export function splitCue(doc: ProjectDoc, cueId: string, atMs: number): { doc: ProjectDoc; left: string; right: string } | null {
  const c = doc.subtitles.find((x) => x.id === cueId);
  if (!c || atMs <= c.startMs || atMs >= c.endMs) return null;
  const next = cloneDoc(doc);
  const i = next.subtitles.findIndex((x) => x.id === cueId);
  const leftW = c.words.filter((w) => w.startMs < atMs);
  const rightW = c.words.filter((w) => w.startMs >= atMs);
  // text split: word boundary when word timings exist, else char midpoint
  const textAt = leftW.length ? leftW.map((w) => w.word).join("").length : Math.floor(c.text.length / 2);
  const l: SubtitleCue = { ...c, id: uid(), endMs: atMs, text: c.text.slice(0, textAt).trim(), words: leftW };
  const r: SubtitleCue = { ...c, id: uid(), startMs: atMs, text: c.text.slice(textAt).trim(), words: rightW };
  next.subtitles.splice(i, 1, l, r);
  next.subtitles.sort((a, b) => a.startMs - b.startMs);
  return { doc: next, left: l.id, right: r.id };
}

/** Merge cueId with the FOLLOWING cue (gap collapses). */
export function mergeCueWithNext(doc: ProjectDoc, cueId: string): { doc: ProjectDoc; mergedId: string } | null {
  const i = doc.subtitles.findIndex((x) => x.id === cueId);
  if (i < 0 || i + 1 >= doc.subtitles.length) return null;
  const a = doc.subtitles[i], b = doc.subtitles[i + 1];
  const next = cloneDoc(doc);
  const merged: SubtitleCue = {
    id: uid(),
    startMs: a.startMs,
    endMs: Math.max(a.endMs, b.endMs),
    text: `${a.text} ${b.text}`.trim(),
    styleId: a.styleId ?? b.styleId ?? null,
    words: [...a.words, ...b.words],
  };
  next.subtitles.splice(i, 2, merged);
  return { doc: next, mergedId: merged.id };
}

/** Shift every cue (and word times) by deltaMs — negative shifts clamp at 0. */
export function shiftAllCues(doc: ProjectDoc, deltaMs: number): ProjectDoc {
  const next = cloneDoc(doc);
  for (const c of next.subtitles) {
    const shift = Math.max(-c.startMs, deltaMs);
    c.startMs += shift; c.endMs += shift;
    for (const w of c.words) { w.startMs += shift; w.endMs += shift; }
  }
  return next;
}

/** Scale cue timings (reading speed) around anchor 0 — factor>1 slower. */
export function scaleCueTimes(doc: ProjectDoc, factor: number): ProjectDoc {
  const next = cloneDoc(doc);
  for (const c of next.subtitles) {
    c.startMs = Math.round(c.startMs * factor);
    c.endMs = Math.max(c.startMs + 1, Math.round(c.endMs * factor));
    for (const w of c.words) { w.startMs = Math.round(w.startMs * factor); w.endMs = Math.round(w.endMs * factor); }
  }
  return next;
}

/** Resolve overlaps: earlier cue's end clamps to next cue's start. */
export function fixOverlaps(doc: ProjectDoc): ProjectDoc {
  const next = cloneDoc(doc);
  next.subtitles.sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i + 1 < next.subtitles.length; i++) {
    const a = next.subtitles[i], b = next.subtitles[i + 1];
    if (a.endMs > b.startMs) a.endMs = Math.max(a.startMs + 1, b.startMs);
  }
  return next;
}

export function findReplaceCues(doc: ProjectDoc, find: string, replace: string): { doc: ProjectDoc; count: number } {
  const next = cloneDoc(doc);
  let count = 0;
  for (const c of next.subtitles) {
    const hits = c.text.split(find).length - 1;
    if (hits > 0) { c.text = c.text.split(find).join(replace); count += hits; }
  }
  return { doc: next, count };
}

export interface CueIssue { cueId: string; kind: "overlap" | "tooShort" | "tooLong" | "longLine" | "unnatural"; detail: string; }
/** Diagnostics — never mutates; user reviews then applies a fix op. */
export function diagnoseCues(doc: ProjectDoc): CueIssue[] {
  const issues: CueIssue[] = [];
  const cues = [...doc.subtitles].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const dur = c.endMs - c.startMs;
    if (dur < 800) issues.push({ cueId: c.id, kind: "tooShort", detail: `${dur}ms` });
    if (dur > 8000) issues.push({ cueId: c.id, kind: "tooLong", detail: `${dur}ms` });
    if (c.text.split("\n").some((l) => l.length > 42)) issues.push({ cueId: c.id, kind: "longLine", detail: ">42 chars" });
    const cps = c.text.length / (dur / 1000);
    if (dur > 0 && (cps > 25 || cps < 2)) issues.push({ cueId: c.id, kind: "unnatural", detail: `${cps.toFixed(0)} cps` });
    if (i + 1 < cues.length && c.endMs > cues[i + 1].startMs) issues.push({ cueId: c.id, kind: "overlap", detail: `+${c.endMs - cues[i + 1].startMs}ms` });
  }
  return issues;
}

export function activeCueAt(doc: ProjectDoc, tMs: number): SubtitleCue | null {
  return doc.subtitles.find((c) => tMs >= c.startMs && tMs < c.endMs) ?? null;
}


// ---------- audio studio (ADR-026) ----------

export function upsertDuckingRule(doc: ProjectDoc, rule: DuckingRule): ProjectDoc {
  const next = cloneDoc(doc);
  const i = next.ducking.findIndex((r) => r.id === rule.id);
  if (i >= 0) next.ducking[i] = { ...rule };
  else next.ducking.push({ ...rule });
  return next;
}

export function removeDuckingRule(doc: ProjectDoc, ruleId: string): ProjectDoc {
  const next = cloneDoc(doc);
  next.ducking = next.ducking.filter((r) => r.id !== ruleId);
  return next;
}

/**
 * Silence auto-cut proposal application: replaces `clipId` with clips for
 * the NON-silent source regions (padding preserved). Returns null when the
 * result would be a no-op. Undo-safe via mutate — user reviews first.
 */
export function applySilenceCut(
  doc: ProjectDoc,
  clipId: string,
  silence: { startMs: number; endMs: number }[],
  padMs: number,
): ProjectDoc | null {
  const found = findClip(doc, clipId);
  if (!found) return null;
  const { clip, track } = found;
  const srcDur = clip.sourceDurationMs ?? clip.durationMs;
  // keep-regions in source time = complement of silence, padded into speech
  const keeps: [number, number][] = [];
  let cur = clip.sourceInMs;
  const sorted = [...silence].sort((a, b) => a.startMs - b.startMs);
  for (const r of sorted) {
    const end = Math.min(clip.sourceInMs + srcDur, r.startMs + padMs);
    if (end > cur + 1) keeps.push([cur, end]);
    cur = Math.max(cur, r.endMs - padMs);
  }
  const tail = clip.sourceInMs + srcDur;
  if (tail > cur + 1) keeps.push([cur, tail]);
  if (keeps.length <= 1) return null; // nothing removable
  const next = cloneDoc(doc);
  const tr = next.timeline.tracks.find((t) => t.id === track.id)!;
  const i = tr.clips.findIndex((c) => c.id === clipId);
  const newClips: import("@/lib/project-types").Clip[] = keeps.map(([sin, sout], k) => {
    const prevEnd = k === 0 ? clip.startMs : clip.startMs + keeps
      .slice(0, k)
      .reduce((a, [s2, e2]) => a + (e2 - s2), 0);
    return {
      ...clip,
      id: uid(),
      startMs: prevEnd,
      durationMs: Math.max(1, Math.round(sout - sin)),
      sourceInMs: Math.round(sin),
      keyframes: {},
    };
  });
  tr.clips.splice(i, 1, ...newClips);
  return next;
}


// ---------- graphics studio (ADR-027) ----------

/** Insert a generated clip (title/shape) onto a text or graphics track. */
export function addGeneratedClip(
  doc: ProjectDoc,
  kind: "text" | "graphics",
  fields: {
    startMs: number;
    durationMs: number;
    text?: string;
    textStyle?: TextStyle;
    shape?: import("@/lib/project-types").ShapeSpec;
    transform?: Partial<import("@/lib/project-types").Transform>;
  },
): { doc: ProjectDoc; clipId: string } {
  const next = cloneDoc(doc);
  const track = ensureTrack(next.timeline, kind, kind === "text" ? "T" : "G");
  const clip: Clip = {
    id: uid(),
    mediaRef: null,
    startMs: Math.max(0, Math.round(fields.startMs)),
    durationMs: Math.max(1, Math.round(fields.durationMs)),
    sourceInMs: 0,
    transform: {
      ...DEFAULT_TRANSFORM,
      ...(fields.transform ?? {}),
    },
    effects: [],
    volume: 1,
    pan: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    speed: 1,
    text: fields.text ?? null,
    textStyle: fields.textStyle ?? null,
    keyframes: {},
    shape: fields.shape ?? null,
    textFx: null,
    hidden: false,
    brandBindings: null,
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startMs - b.startMs);
  return { doc: next, clipId: clip.id };
}

/** Apply an animation preset — bakes eased keyframes / sets textFx.
 *  When a version is active, writes into that version's keyframe
 *  overrides so other versions stay untouched. */
export function applyAnimationPreset(
  doc: ProjectDoc,
  clipId: string,
  presetId: string,
  opts: { durationMs: number; delayMs?: number; intensity?: number; direction?: string; easing?: string; versionId?: string | null },
): ProjectDoc {
  const preset = animPreset(presetId);
  const hit = findClip(doc, clipId);
  if (!preset || !hit) return doc;
  const built = preset.build(hit.clip, doc.canvas, {
    durationMs: Math.max(50, opts.durationMs),
    delayMs: opts.delayMs ?? 0,
    intensity: opts.intensity ?? 160,
    direction: opts.direction ?? "left",
    easing: (opts.easing as never) ?? "easeOut",
  });
  if (built.textFx !== undefined && !supportsTextFx(doc, clipId)) return doc;
  // Tag baked keyframes with the preset id so the timeline can group and
  // retime each start/end animation as its own strip.
  for (const arr of Object.values(built.keyframes))
    for (const k of arr) k.anim = presetId;
  if (opts.versionId) {
    const v = doc.versions.find((vv) => vv.id === opts.versionId);
    if (!v) return doc;
    const next = cloneDoc(doc);
    const vv = next.versions.find((x) => x.id === opts.versionId)!;
    const ov = (vv.clipOverrides[clipId] ??= {});
    ov.keyframes = { ...(ov.keyframes ?? {}) };
    for (const [path, kfs] of Object.entries(built.keyframes)) ov.keyframes[path] = kfs;
    if (built.textFx !== undefined) ov.textFx = built.textFx;
    return next;
  }
  const next = cloneDoc(doc);
  const c = findClip(next, clipId)!;
  const kf = { ...c.clip.keyframes };
  for (const [path, kfs] of Object.entries(built.keyframes)) kf[path] = kfs;
  c.clip.keyframes = kf;
  if (built.textFx !== undefined) c.clip.textFx = built.textFx;
  return next;
}

/** Patch a clip's procedural text animation (typewriter/wipe/blur).
 *  The strip drag writes `durationMs` (wipe/blur window) or `rate`
 *  (typewriter chars/s). Version-override aware, like applyAnimationPreset. */
export function updateTextFx(
  doc: ProjectDoc,
  clipId: string,
  versionId: string | null | undefined,
  patch: Partial<Pick<TextFx, "rate" | "durationMs" | "direction">>,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const apply = (fx: TextFx | null | undefined): TextFx | null => {
    if (!fx) return fx ?? null;
    const out = { ...fx, ...patch };
    if (out.durationMs != null) out.durationMs = Math.max(0, Math.round(out.durationMs));
    if (out.rate != null) out.rate = Math.max(0.1, out.rate);
    return out;
  };
  if (versionId) {
    const v = next.versions.find((vv) => vv.id === versionId);
    if (!v) return next;
    const ov = v.clipOverrides[clipId];
    if (ov?.textFx) ov.textFx = apply(ov.textFx);
    else if (hit.clip.textFx) {
      // Shadow the base value into the override so other versions keep theirs.
      const ovv = (v.clipOverrides[clipId] ??= {});
      ovv.textFx = apply(hit.clip.textFx);
    }
    return next;
  }
  hit.clip.textFx = apply(hit.clip.textFx);
  return next;
}

/** Retime the keyframes of one animation group through `map` (clip-relative
 *  ms → ms). `tag` selects the group: a preset id ("fadeIn") retimes only
 *  keyframes it baked; `undefined` retimes hand-placed (untagged) ones.
 *  Version-override paths write back to the override, the rest to base. */
export function retimeClipKeyframes(
  doc: ProjectDoc,
  clipId: string,
  versionId: string | null | undefined,
  tag: string | undefined,
  map: (tMs: number) => number,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit || hit.track.locked) return next;
  const dur = hit.clip.durationMs;
  const retimeArr = (arr: Keyframe[]) =>
    arr.map((k) =>
      k.anim === tag
        ? { ...k, tMs: Math.max(0, Math.min(dur, Math.round(map(k.tMs)))) }
        : k,
    );
  const ov = versionId
    ? next.versions.find((v) => v.id === versionId)?.clipOverrides[clipId]
    : undefined;
  const ovKf = ov?.keyframes ?? {};
  // Paths shadowed by the version override keep base untouched; the
  // override carries the retimed copies instead.
  hit.clip.keyframes = Object.fromEntries(
    Object.entries(hit.clip.keyframes).map(([p, arr]) => [
      p,
      ovKf[p] ? arr : retimeArr(arr),
    ]),
  );
  if (ov?.keyframes)
    ov.keyframes = Object.fromEntries(
      Object.entries(ovKf).map(([p, arr]) => [p, retimeArr(arr)]),
    );
  return next;
}

/** Drop ALL version overrides for one clip — re-syncs it to the shared
 *  base (the "link" half of per-version link/unlink, ADR-021/027). */
export function clearVersionClipOverrides(
  doc: ProjectDoc,
  versionId: string,
  clipId: string,
): ProjectDoc {
  const next = cloneDoc(doc);
  const v = next.versions.find((x) => x.id === versionId);
  if (v) delete v.clipOverrides[clipId];
  return next;
}

/** Copy a clip's visual style (textStyle/shape/effects) for paste-style. */
export function clipStylePayload(clip: Clip): { textStyle?: TextStyle | null; shape?: Clip["shape"]; effects: Clip["effects"] } {
  return {
    textStyle: clip.textStyle ? { ...clip.textStyle } : null,
    shape: clip.shape ? { ...clip.shape } : null,
    effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })),
  };
}

/** Paste style payload onto a clip (undo-safe via mutate). */
export function applyClipStyle(
  doc: ProjectDoc,
  clipId: string,
  style: { textStyle?: TextStyle | null; shape?: Clip["shape"]; effects?: Clip["effects"] },
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  if (style.textStyle !== undefined) hit.clip.textStyle = style.textStyle ? { ...style.textStyle } : null;
  if (style.shape !== undefined) hit.clip.shape = style.shape ? { ...style.shape } : null;
  if (style.effects) hit.clip.effects = style.effects.map((e) => ({ ...e, params: { ...e.params } }));
  return next;
}

/** Anchor a clip inside the canvas via transform.x/y (align tools). */
export function alignClipTo(
  doc: ProjectDoc,
  clipId: string,
  anchor: "left" | "center" | "right" | "top" | "middle" | "bottom",
  marginPx = 0,
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  const { width, height } = next.canvas;
  switch (anchor) {
    case "left": hit.clip.transform.x = -width / 2 + marginPx; break;
    case "center": hit.clip.transform.x = 0; break;
    case "right": hit.clip.transform.x = width / 2 - marginPx; break;
    case "top": hit.clip.transform.y = -height / 2 + marginPx; break;
    case "middle": hit.clip.transform.y = 0; break;
    case "bottom": hit.clip.transform.y = height / 2 - marginPx; break;
  }
  return next;
}

// ---------- brand kit ops (ADR-027) ----------

/** Embed a kit snapshot into the doc and set it active. */
export function setDocBrandKit(
  doc: ProjectDoc,
  kit: import("@/lib/project-types").BrandKit | null,
): ProjectDoc {
  const next = cloneDoc(doc);
  next.brandKitId = kit?.id ?? null;
  next.brandKit = kit ? { ...kit } : null;
  return next;
}

/** Bind clip color/font slots to the doc's brand snapshot and APPLY the
 *  current values (undo-safe). Unbind with both slots null. */
export function bindClipBrand(
  doc: ProjectDoc,
  clipId: string,
  slots: { colorSlot?: number | null; fontSlot?: number | null },
): ProjectDoc {
  const next = cloneDoc(doc);
  const hit = findClip(next, clipId);
  if (!hit) return next;
  const kit = next.brandKit;
  const bound = { colorSlot: slots.colorSlot ?? null, fontSlot: slots.fontSlot ?? null };
  hit.clip.brandBindings = bound.colorSlot === null && bound.fontSlot === null ? null : bound;
  if (kit) {
    if (bound.colorSlot !== null && kit.colors[bound.colorSlot]) {
      const col = kit.colors[bound.colorSlot];
      if (hit.clip.shape) hit.clip.shape.fill = col;
      else hit.clip.textStyle = { ...(hit.clip.textStyle ?? DEFAULT_TEXT_STYLE), color: col };
    }
    if (bound.fontSlot !== null && kit.fonts[bound.fontSlot]) {
      hit.clip.textStyle = {
        ...(hit.clip.textStyle ?? DEFAULT_TEXT_STYLE),
        fontFile: kit.fonts[bound.fontSlot].path,
      };
    }
  }
  return next;
}

/** Re-apply the embedded snapshot to every bound clip — explicit user
 *  action; bound clips only, custom/unbound values never touched. */
export function applyBrandToBoundClips(doc: ProjectDoc): ProjectDoc {
  const kit = doc.brandKit;
  if (!kit) return doc;
  let next = doc;
  for (const t of doc.timeline.tracks) {
    for (const c of t.clips) {
      const b = c.brandBindings;
      if (!b) continue;
      next = bindClipBrand(next, c.id, b);
    }
  }
  return next;
}

export function setVersionSubtitleStyle(doc: ProjectDoc, versionId: string, style: SubtitleStyle): ProjectDoc {
  const next = cloneDoc(doc);
  const v = next.versions.find((x) => x.id === versionId);
  if (!v) return next;
  v.subtitleStyle = { ...style };
  return next;
}

import type { Canvas, SafeZones } from "@/lib/project-types";
