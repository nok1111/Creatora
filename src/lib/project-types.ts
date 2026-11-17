/** TS mirror of src-tauri/src/project/document.rs (format_version 1). */

export interface ProjectDoc {
  formatVersion: number;
  meta: Meta;
  canvas: Canvas;
  timeline: Timeline;
  /** Derived format versions — ADR-021. v2+. */
  versions: FormatVersion[];
  subtitles: SubtitleCue[];
  /** Master subtitle presentation — versions may override. */
  subtitleStyle: SubtitleStyle;
  /** Saved named styles for per-cue styling (cue.styleId). v2+. */
  subtitleStyles?: NamedSubtitleStyle[];
  brandKitId: string | null;
  /** Embedded snapshot — self-contained (ADR-027). */
  brandKit?: BrandKit | null;
  exportProfiles: unknown[];
  mediaRefs: MediaRef[];
  /** Auto-duck rules (ADR-026). */
  ducking: DuckingRule[];
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
  /** Per-track gain (0–8), post-clip (ADR-026). */
  volume: number;
  /** Any solo track mutes all non-solo tracks. */
  solo: boolean;
}

/** Non-destructive auto-duck — render uses sidechaincompress (ADR-026). */
export interface DuckingRule {
  id: string;
  sourceTrack: string;
  targetTrack: string;
  /** Trigger level dBFS. */
  thresholdDb: number;
  /** Max depth, negative dB. */
  reductionDb: number;
  attackMs: number;
  releaseMs: number;
  holdMs: number;
}

export interface Transition {
  id: string;
  /** "crossfade" | "dipToBlack" | "dipToWhite" | future kinds */
  type: string;
  durationMs: number;
  /** Outgoing → incoming clip ids on the same track. */
  clipA: string;
  clipB: string;
  /** Library-transition parameters (shared/fx manifest). Absent for the
   *  legacy xfade kinds. */
  params?: Record<string, number>;
  /** Ease curve name from the manifest; absent = the entry's default. */
  ease?: string;
}

export interface Effect {
  id: string;
  /** Registry key — see lib/effects.ts + render/effects.rs */
  type: string;
  enabled: boolean;
  params: Record<string, number>;
  /** Clip-relative activation window in ms — undefined edge = unbounded
      (whole clip). Render encodes it as ffmpeg `enable='between(t,…)'`. */
  inMs?: number;
  outMs?: number;
  /** Path to an asset the effect needs (lut → .cube file). */
  file?: string | null;
  /** Analysis data owned by the effect: source-time ms of detected beats
   *  (beatImpact). Kept in the project so renders are deterministic. */
  times?: number[] | null;
}

export interface TextStyle {
  /** Absolute font path; null → platform default. */
  fontFile?: string | null;
  /** System font family name (e.g. "Impact", "Georgia") — used when
   *  fontFile is null; lets presets name fonts without shipping files. */
  fontName?: string | null;
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
  /** Drop shadow — drawtext shadowcolor/x/y ↔ CSS text-shadow. ADR-027. */
  shadowColor?: string | null;
  shadowX?: number;
  shadowY?: number;
  /** Extra px between wrapped lines (drawtext line_spacing). */
  lineSpacingPx?: number;
}

export interface SafeZones {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ExportSettings {
  /** "libx264" | "libx265" | "libvpx-vp9" — validated, never ignored. */
  codec: string;
  preset: string;
  crf: number;
  /** Rate-control override — wins over crf when set. */
  videoBitrate?: string | null;
  /** "aac" | "libopus" | "libmp3lame" | "pcm_s16le" | "none" */
  audioCodec: string;
  audioBitrate: string;
  audioRate: number;
  /** "mp4" | "mov" | "mkv" | "webm" */
  container: string;
  /** Platform cap metadata — render does NOT truncate. 0 = none. */
  maxDurationMs: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  codec: "libx264",
  preset: "veryfast",
  crf: 20,
  videoBitrate: null,
  audioCodec: "aac",
  audioBitrate: "192k",
  audioRate: 48000,
  container: "mp4",
  maxDurationMs: 0,
};

/** Validated combos — mirror of plan.rs::validate_export. */
export const EXPORT_MATRIX = {
  videoCodecs: ["libx264", "libx265", "libvpx-vp9"] as const,
  presets: ["ultrafast","superfast","veryfast","faster","fast","medium","slow","slower","veryslow"] as const,
  audioCodecs: ["aac", "libopus", "libmp3lame", "pcm_s16le", "none"] as const,
  containers: ["mp4", "mov", "mkv", "webm"] as const,
};

export function validateExportSettings(s: ExportSettings): string | null {
  if (!EXPORT_MATRIX.videoCodecs.includes(s.codec as never)) return `unsupported video codec: ${s.codec}`;
  if (!EXPORT_MATRIX.presets.includes(s.preset as never)) return `unsupported preset: ${s.preset}`;
  if (!EXPORT_MATRIX.audioCodecs.includes(s.audioCodec as never)) return `unsupported audio codec: ${s.audioCodec}`;
  if (!EXPORT_MATRIX.containers.includes(s.container as never)) return `unsupported container: ${s.container}`;
  if (s.container === "webm" && s.codec !== "libvpx-vp9") return "webm requires libvpx-vp9 video";
  if (s.container === "webm" && !["libopus", "none"].includes(s.audioCodec)) return "webm requires libopus audio (or none)";
  if ((s.container === "mp4" || s.container === "mov") && s.codec === "libvpx-vp9") return "mp4/mov cannot carry VP9 — use mkv/webm";
  if (s.crf > 51) return "crf out of range (0..51)";
  return null;
}

/** Whitelisted per-clip fields a version may override (present = replace). */
export interface ClipOverride {
  transform?: Transform;
  /** Replaces ONLY listed keyframe paths. */
  keyframes?: Record<string, Keyframe[]>;
  textStyle?: TextStyle;
  /** Independent copy per version. */
  text?: string;
  /** Per-version visibility (true = hidden in this version). ADR-027. */
  hidden?: boolean;
  /** Per-version procedural animation (typewriter/wipe/blur). ADR-027. */
  textFx?: TextFx | null;
}

export interface FormatVersion {
  id: string;
  name: string;
  presetId?: string | null;
  canvas: Canvas;
  safeZones: SafeZones;
  clipOverrides: Record<string, ClipOverride>;
  export: ExportSettings;
  /** Per-version subtitle presentation — null inherits doc.subtitleStyle. */
  subtitleStyle?: SubtitleStyle | null;
}

/** Canonical subtitle presentation — mirrors SubtitleStyle (ADR-025).
 * Reuses TextStyle for glyphs; adds karaoke + cue layout. */
export interface SubtitleStyle {
  text: TextStyle;
  /** Karaoke word-highlight color. */
  highlightColor: string;
  /** "none" | "karaoke" (\k fill) | "pop" (active word only). */
  mode: string;
  /** Bottom margin in canvas px. */
  marginVPx: number;
  marginHPx: number;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFile: null,
  fontName: null,
  fontSizePx: 48,
  color: "#FFFFFF",
  outlineColor: null,
  outlineWidth: 0,
  backgroundColor: null,
  backgroundPadPx: 8,
  alignH: "center",
  alignV: "middle",
  shadowColor: null,
  shadowX: 0,
  shadowY: 0,
  lineSpacingPx: 0,
};

/** Named, user-saved subtitle style — lives in doc.subtitleStyles so it
    travels with the project; cue.styleId points at these ids. */
export interface NamedSubtitleStyle {
  id: string;
  name: string;
  style: SubtitleStyle;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  text: { ...DEFAULT_TEXT_STYLE, alignV: "bottom", outlineColor: "#000000", outlineWidth: 2 },
  highlightColor: "#00E5FF",
  mode: "none",
  marginVPx: 48,
  marginHPx: 40,
};

export interface Keyframe {
  /** ms relative to clip start. */
  tMs: number;
  v: number;
  ease: string;
  /** Preset id that baked this keyframe (start/end effects) — lets the
   *  timeline group and retime each animation independently. */
  anim?: string;
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
  /** Stereo balance −1..+1 (ADR-026). */
  pan: number;
  /** Clip-level fades in ms — distinct from transition crossfades. */
  fadeInMs: number;
  fadeOutMs: number;
  speed: number;
  text?: string | null;
  /** Canonical text styling — mirrors render/text.rs (ADR-020). */
  textStyle?: TextStyle | null;
  /** property path ("transform.x", "volume", …) → samples, clip-relative ms. */
  keyframes: Record<string, Keyframe[]>;
  shape?: ShapeSpec | null;
  textFx?: TextFx | null;
  hidden?: boolean;
  brandBindings?: BrandBindings | null;
}

/** Generated shape on a graphics clip (ADR-027). */
export interface ShapeSpec {
  /** "rect" | "line" — ellipse intentionally unsupported (drawbox). */
  kind: string;
  fill: string;
  outlineColor?: string | null;
  outlineWidth: number;
  widthPx: number;
  heightPx: number;
}

/** Procedural text animation beyond keyframes (ADR-027). */
export interface TextFx {
  /** "typewriter" | "wipe" | "blur" */
  kind: string;
  /** typewriter: chars/second · blur: max sigma px */
  rate: number;
  /** wipe: "ltr" | "rtl" | "ttb" | "btt" */
  direction: string;
  /** wipe/blur: window length, clip-relative ms */
  durationMs: number;
  /** true = exit variant anchored at the clip tail. */
  out?: boolean;
}

export interface BrandBindings {
  colorSlot?: number | null;
  fontSlot?: number | null;
}

export interface BrandFont {
  name: string;
  path: string;
}

export interface BrandLogo {
  name: string;
  path: string;
  role?: string;
}

/** Brand kit — stored app-side, snapshotted into the doc (ADR-027). */
export interface BrandKit {
  id: string;
  name: string;
  colors: string[];
  fonts: BrandFont[];
  logos: BrandLogo[];
  titleStyle: TextStyle;
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
