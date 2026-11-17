/**
 * Repurpose — pure helpers that turn analysis output (transcript + clip
 * candidates from `repurpose_analyze`) into editable Creatora projects.
 * No IPC here: everything is a function over documents so it is testable
 * and the generated project is exactly what the normal editor would build.
 */
import type {
  Clip,
  Keyframe,
  ProjectDoc,
  SubtitleCue,
  SubtitleStyle,
} from "@/lib/project-types";
import { defaultReframe, presetById, type FormatPreset } from "@/lib/format-presets";
import { addClip, addVersion, setVersionClipOverride } from "@/lib/timeline-engine";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@/lib/social-types";

export interface Candidate {
  id: string;
  rank: number;
  startMs: number;
  endMs: number;
  score: number;
  title: string;
  text: string;
  reasons: string[];
}

export interface AnalyzeResult {
  durationMs: number;
  cues: SubtitleCue[];
  candidates: Candidate[];
  cached: boolean;
  /** Every transcript cue is non-verbal markup — no spoken content to clip. */
  noSpeech: boolean;
  hasEnergy: boolean;
  /** Source frame rate (capped at 60) — new projects keep it. */
  fpsNum: number;
  fpsDen: number;
}

export interface LengthPreset {
  id: "short" | "standard" | "long";
  minMs: number;
  idealMs: number;
  maxMs: number;
}

export const LENGTH_PRESETS: LengthPreset[] = [
  { id: "short", minMs: 15_000, idealMs: 22_000, maxMs: 30_000 },
  { id: "standard", minMs: 30_000, idealMs: 45_000, maxMs: 60_000 },
  { id: "long", minMs: 60_000, idealMs: 75_000, maxMs: 90_000 },
];

/** Presets offered as publishing targets (each maps to a social platform). */
export const TARGET_PRESET_IDS = [
  "tiktok-9x16-1080",
  "ig-reels-9x16-1080",
  "shorts-9x16-1080",
  "fb-9x16-1080",
  "ig-feed-4x5-1080",
  "yt-16x9-1080",
] as const;

export const DEFAULT_TARGET_IDS: string[] = [
  "tiktok-9x16-1080",
  "ig-reels-9x16-1080",
  "shorts-9x16-1080",
];

export const MIN_CLIP_MS = 5_000;
export const MAX_CLIP_MS = 180_000;

/** The social platform a preset publishes to (null for generic ratios). */
export function platformOfPreset(p: FormatPreset): SocialPlatform | null {
  const k = p.platform?.toLowerCase();
  return SOCIAL_PLATFORMS.find((s) => s === k) ?? null;
}

/** Keep a trimmed range inside the source and within sane clip bounds. */
export function clampRange(
  startMs: number,
  endMs: number,
  durationMs: number,
): { startMs: number; endMs: number } {
  const s = Math.min(Math.max(0, Math.round(startMs)), Math.max(0, durationMs - MIN_CLIP_MS));
  let e = Math.min(durationMs, Math.round(endMs));
  e = Math.max(e, s + MIN_CLIP_MS);
  e = Math.min(e, s + MAX_CLIP_MS, durationMs);
  return { startMs: s, endMs: e };
}

/** Evenly seeded manual ranges — clip i is centred in its slot at `lenMs`
 * (clamped to the clip bounds and the source duration). */
export function spreadRanges(
  n: number,
  durationMs: number,
  lenMs: number,
): { id: string; startMs: number; endMs: number }[] {
  if (n <= 0 || durationMs <= 0) return [];
  const len = Math.min(Math.max(MIN_CLIP_MS, lenMs), durationMs);
  const step = durationMs / n;
  return Array.from({ length: n }, (_, i) => {
    const center = step * (i + 0.5);
    return { id: `manual-${i + 1}`, ...clampRange(center - len / 2, center + len / 2, durationMs) };
  });
}

/** Mirrors `is_non_speech_cue` in candidates.rs — a cue that is only
 * non-verbal markup like `[Music]`, `(laughter)` or `*sighs*` is not speech. */
export function isNonSpeechCue(text: string): boolean {
  let rest = text.trim();
  if (!rest) return true;
  while (rest.length) {
    const close = rest[0] === "[" ? "]" : rest[0] === "(" ? ")" : rest[0] === "*" ? "*" : "";
    if (!close) return false;
    const end = rest.indexOf(close, 1);
    if (end < 0) return false;
    const inner = rest.slice(1, end).trim();
    if (!inner || inner.length > 60 || inner.includes(rest[0])) return false;
    rest = rest.slice(end + 1).trimStart();
  }
  return true;
}

/**
 * Cues overlapping [startMs, endMs], re-timed so the clip starts at 0 and
 * clipped to the window. Word timings follow; empty results are dropped.
 */
export function sliceCues(cues: SubtitleCue[], startMs: number, endMs: number): SubtitleCue[] {
  const dur = endMs - startMs;
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    if (c.endMs <= startMs || c.startMs >= endMs) continue;
    const words = c.words
      .filter((w) => w.endMs > startMs && w.startMs < endMs)
      .map((w) => ({
        ...w,
        startMs: Math.max(0, w.startMs - startMs),
        endMs: Math.min(dur, w.endMs - startMs),
      }));
    const text = c.words.length && words.length ? words.map((w) => w.word).join("").trim() : c.text.trim();
    if (!text || isNonSpeechCue(text)) continue;
    out.push({
      ...c,
      id: `cue-${out.length + 1}`,
      startMs: Math.max(0, c.startMs - startMs),
      endMs: Math.min(dur, c.endMs - startMs),
      text,
      words,
    });
  }
  return out;
}

/** Two sentences max, ≤ 220 chars — a usable first draft for a caption. */
export function captionFromText(text: string): string {
  const parts = text.trim().match(/[^.!?…]+[.!?…]+/g) ?? [text.trim()];
  const s = parts.slice(0, 2).map((x) => x.trim()).join(" ");
  if (s.length <= 220) return s;
  const cut = s.slice(0, 220);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : 220).trimEnd()}…`;
}

export interface MotionSample {
  tMs: number;
  cx: number;
  cy: number;
  motion?: boolean;
}

/** Subject-following reframe: base cover-fit + x/y keyframes from samples. */
export function reframeKeyframes(
  samples: MotionSample[],
  src: { width: number; height: number },
  canvas: { width: number; height: number },
) {
  const base = defaultReframe(src.width, src.height, canvas.width, canvas.height);
  const x: Keyframe[] = [];
  const y: Keyframe[] = [];
  for (const s of samples) {
    const r = defaultReframe(src.width, src.height, canvas.width, canvas.height, s.cx, s.cy);
    x.push({ tMs: s.tMs, v: r.x, ease: "linear" });
    y.push({ tMs: s.tMs, v: r.y, ease: "linear" });
  }
  return { base, x, y };
}

export interface BuildClipOpts {
  /** Fresh doc from `create_project` (empty timeline). */
  base: ProjectDoc;
  asset: { id: string; filePath: string; width: number; height: number; durationMs: number | null };
  startMs: number;
  endMs: number;
  /** Full-source transcript — sliced here. */
  cues: SubtitleCue[];
  /** First preset is the master canvas; the rest become format versions. */
  presetIds: string[];
  captions: boolean;
  captionStyle: SubtitleStyle;
  /** Motion samples for the clip range (optional subject following). */
  motion?: MotionSample[];
}

export interface BuiltClip {
  doc: ProjectDoc;
  clipId: string;
  /** presetId → version id (null = the master itself). */
  versionByPreset: Record<string, string | null>;
}

export function buildClipDoc(o: BuildClipOpts): BuiltClip {
  const presets = o.presetIds.map((id) => presetById(id)).filter((p): p is FormatPreset => !!p);
  if (!presets.length) throw new Error("no target format selected");
  const master = presets[0]!;
  const dur = o.endMs - o.startMs;

  let doc: ProjectDoc = structuredClone(o.base);
  doc.canvas = { ...doc.canvas, width: master.canvas.width, height: master.canvas.height };
  if (!doc.mediaRefs.some((m) => m.assetId === o.asset.id)) {
    doc.mediaRefs.push({ assetId: o.asset.id, path: o.asset.filePath, hash: null });
  }

  const added = addClip(doc, {
    mediaRef: o.asset.id,
    startMs: 0,
    durationMs: dur,
    sourceInMs: o.startMs,
    sourceDurationMs: o.asset.durationMs,
  });
  doc = added.doc;
  const clipId = added.clipId;

  const src = { width: o.asset.width, height: o.asset.height };
  const clipOf = (d: ProjectDoc): Clip => {
    for (const t of d.timeline.tracks) for (const c of t.clips) if (c.id === clipId) return c;
    throw new Error("clip vanished");
  };

  // Master: cover-fit (+ subject following when motion data is present).
  const m = reframeKeyframes(o.motion ?? [], src, master.canvas);
  const mc = clipOf(doc);
  mc.transform = { ...mc.transform, x: m.base.x, y: m.base.y, scaleX: m.base.scale, scaleY: m.base.scale };
  if (o.motion?.length) mc.keyframes = { ...mc.keyframes, "transform.x": m.x, "transform.y": m.y };

  const versionByPreset: Record<string, string | null> = { [master.id]: null };
  for (const p of presets.slice(1)) {
    const same = p.canvas.width === master.canvas.width && p.canvas.height === master.canvas.height;
    const v = addVersion(doc, {
      name: p.label,
      presetId: p.id,
      canvas: { ...doc.canvas, width: p.canvas.width, height: p.canvas.height },
      safeZones: p.safeZones,
    });
    doc = v.doc;
    versionByPreset[p.id] = v.versionId;
    const k = same ? m : reframeKeyframes(o.motion ?? [], src, p.canvas);
    doc = setVersionClipOverride(doc, v.versionId, clipId, {
      transform: { ...clipOf(doc).transform, x: k.base.x, y: k.base.y, scaleX: k.base.scale, scaleY: k.base.scale },
      ...(o.motion?.length ? { keyframes: { "transform.x": k.x, "transform.y": k.y } } : {}),
    });
  }

  if (o.captions) {
    doc.subtitles = sliceCues(o.cues, o.startMs, o.endMs);
    doc.subtitleStyle = structuredClone(o.captionStyle);
  }
  return { doc, clipId, versionByPreset };
}
