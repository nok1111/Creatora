import type { AssetKind } from "@/lib/media-types";

/**
 * In-flight drag payload for media-bin → timeline drops.
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
}

let current: MediaDragPayload | null = null;

export function setDragPayload(p: MediaDragPayload | null) {
  current = p;
}

export function getDragPayload(): MediaDragPayload | null {
  return current;
}
