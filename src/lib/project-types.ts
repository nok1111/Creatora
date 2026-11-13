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
  locked: boolean;
  visible: boolean;
  muted: boolean;
}

export interface Clip {
  id: string;
  mediaRef?: string | null;
  startMs: number;
  durationMs: number;
  sourceInMs: number;
  sourceOutMs?: number | null;
  transform: Transform;
  effects: unknown[];
  volume: number;
  speed: number;
  text?: string | null;
  keyframes: Record<string, unknown>;
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
