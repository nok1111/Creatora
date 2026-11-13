/** TS mirror of src-tauri/src/project/document.rs (format_version 1). */

export interface ProjectDoc {
  formatVersion: number;
  meta: Meta;
  canvas: Canvas;
  timeline: Timeline;
  formats: Record<string, unknown>;
  subtitles: SubtitleCue[];
  brandKitId: string | null;
  exportProfiles: unknown[];
  mediaRefs: MediaRef[];
}

export interface Meta {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  creatoraVersion: string;
  sourceProjectId?: string | null;
}

export interface Canvas {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  background: string;
}

export interface Timeline {
  tracks: Track[];
  markers: Marker[];
}

export type TrackKind = "video" | "audio" | "image" | "text" | "graphics";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  transitions: Transition[];
  locked: boolean;
  visible: boolean;
  muted: boolean;
}

export interface Transition {
  id: string;
  /** "crossfade" | "dipToBlack" | "dipToWhite" | future kinds */
  type: string;
  durationMs: number;
  /** Outgoing → incoming clip ids on the same track. */
  clipA: string;
  clipB: string;
}

export interface Effect {
  id: string;
  /** Registry key — see lib/effects.ts + render/effects.rs */
  type: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface TextStyle {
  /** Absolute font path; null → platform default. */
  fontFile?: string | null;
  fontSizePx: number;
  /** "#RRGGBB" or "#RRGGBBAA". */
  color: string;
  outlineColor?: string | null;
  outlineWidth: number;
  backgroundColor?: string | null;
  backgroundPadPx: number;
  /** "left" | "center" | "right" */
  alignH: string;
  /** "top" | "middle" | "bottom" */
  alignV: string;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFile: null,
  fontSizePx: 48,
  color: "#FFFFFF",
  outlineColor: null,
  outlineWidth: 0,
  backgroundColor: null,
  backgroundPadPx: 8,
  alignH: "center",
  alignV: "middle",
};

export interface Keyframe {
  /** ms relative to clip start. */
  tMs: number;
  v: number;
  ease: string;
}

export interface Clip {
  id: string;
  mediaRef?: string | null;
  startMs: number;
  durationMs: number;
  sourceInMs: number;
  sourceOutMs?: number | null;
  /** Full source-media duration — lets trim clamp to real bounds. */
  sourceDurationMs?: number | null;
  transform: Transform;
  effects: Effect[];
  volume: number;
  speed: number;
  text?: string | null;
  /** Canonical text styling — mirrors render/text.rs (ADR-020). */
  textStyle?: TextStyle | null;
  /** property path ("transform.x", "volume", …) → samples, clip-relative ms. */
  keyframes: Record<string, Keyframe[]>;
}

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  opacity: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
}

export interface Marker {
  id: string;
  timeMs: number;
  label: string;
  color?: string | null;
}

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  styleId?: string | null;
  words: WordTiming[];
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface MediaRef {
  assetId: string;
  path: string;
  hash?: string | null;
}

/** Mirrors project::commands::ProjectSummary / OpenProjectResult. */
export interface ProjectSummary {
  id: string;
  name: string;
  filePath: string;
  thumbnailPath: string | null;
  width: number | null;
  height: number | null;
  isFavorite: boolean;
  isArchived: boolean;
  modifiedAt: string;
  lastOpenedAt: string | null;
}

export interface OpenProjectResult {
  doc: ProjectDoc;
  filePath: string;
  recoveryPath: string | null;
}
