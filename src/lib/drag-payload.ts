import type { AssetKind } from "@/lib/media-types";

/**
 * In-flight drag payloads for bin → timeline drops.
 *
 * `dataTransfer.getData` is unreadable during `dragover` (only on `drop`), so
 * the timeline can't know the asset kind/duration to draw a ghost + validate
 * the target lane. The drag source stashes the payload here on `dragstart`
 * and clears it on `dragend`; the drop itself still reads `dataTransfer`.
 */
export interface MediaDragPayload {
  assetId: string;
  filePath: string;
  durationMs: number;
  kind: AssetKind;
  /** Bundled SFX filename — set for Sounds-bin drags, which carry no asset
      row yet (the sound is imported lazily on drop). */
  sfxFile?: string;
}

export type EffectCategory = "start" | "end" | "merge" | "overlay";

/** Effects-bin tile → timeline drop. `itemId` is an ANIM_PRESETS id for
 *  start/end, a transition kind for merge, or an EFFECTS type for overlay. */
export interface EffectDragPayload {
  effect: true;
  category: EffectCategory;
  itemId: string;
}

export type DragPayload = MediaDragPayload | EffectDragPayload;

let current: DragPayload | null = null;

export function setDragPayload(p: DragPayload | null) {
  current = p;
}

export function getDragPayload(): DragPayload | null {
  return current;
}

export function isEffectPayload(p: DragPayload | null): p is EffectDragPayload {
  return !!p && (p as EffectDragPayload).effect === true;
}
