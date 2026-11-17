/**
 * Which library transitions are playing at a given time.
 *
 * Mirrors the overlap math the render uses (`b` starts inside `a`'s tail by
 * the transition duration) so the preview animates exactly the window the
 * export animates.
 */

import type { Clip, ProjectDoc, Transition } from "@/lib/project-types";
import { fxTransition, type FxEntry } from "./manifest";
import { hasTransitionRecipe } from "./gl-transition";

export interface ActiveLibTransition {
  trackId: string;
  tr: Transition;
  entry: FxEntry;
  a: Clip;
  b: Clip;
  /** Linear progress 0→1 inside the overlap. */
  u: number;
}

export function activeLibraryTransitions(doc: ProjectDoc, tMs: number): ActiveLibTransition[] {
  const out: ActiveLibTransition[] = [];
  for (const track of doc.timeline.tracks) {
    if (!track.visible || track.kind === "audio") continue;
    for (const tr of track.transitions) {
      const entry = fxTransition(tr.type);
      if (!hasTransitionRecipe(entry) || tr.durationMs <= 0) continue;
      const a = track.clips.find((c) => c.id === tr.clipA);
      const b = track.clips.find((c) => c.id === tr.clipB);
      if (!a || !b || a.hidden || b.hidden) continue;
      const start = b.startMs;
      const end = Math.min(a.startMs + a.durationMs, start + tr.durationMs);
      if (tMs < start || tMs >= end) continue;
      out.push({ trackId: track.id, tr, entry, a, b, u: (tMs - start) / tr.durationMs });
    }
  }
  return out;
}
