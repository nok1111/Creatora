/**
 * Creative combo presets — one drop applies a curated stack of existing
 * primitives (windowed manifest effects, anim presets, filters, light
 * effects). Nothing is baked: every step lands as its own effect entry
 * or keyframe set, so each part stays independently editable/removable.
 *
 * Design rules: max one intro + one outro window, max two look layers
 * (filter + light) so the stack never becomes visual noise, and no
 * textFx steps — combos must work on any visual clip.
 */
import type { Clip, ProjectDoc } from "@/lib/project-types";
import { fxEntry } from "@/lib/fx/manifest";
import { addEffect, applyAnimationPreset } from "@/lib/timeline-engine";
import { animPreset } from "@/lib/anim-presets";

export interface ComboStep {
  /** manifest effect/filter/light id, or anim preset id */
  id: string;
  /** windowed at the clip edge for intro/outro manifest effects */
  window?: "start" | "end";
}

export interface ComboPreset {
  id: string;
  label: string;
  description: string;
  /** Animated-thumbnail CSS class (index.css). */
  thumb?: string;
  steps: ComboStep[];
}

export const COMBO_PRESETS: ComboPreset[] = [
  {
    id: "cinematicIn",
    label: "Cinematic Intro",
    description: "Rack-focus entrance over a warm film grade.",
    steps: [
      { id: "focusPull", window: "start" },
      { id: "goldenFilm" },
    ],
    thumb: "fxt-cmb-cine",
  },
  {
    id: "neonBoot",
    label: "Digital Impact",
    description: "Signal-lock glitch intro with a neon grade.",
    steps: [
      { id: "glitchBoot", window: "start" },
      { id: "cyberNeon" },
    ],
    thumb: "fxt-cmb-neon",
  },
  {
    id: "dreamHaze",
    label: "Dream Sequence",
    description: "Soft pop-in wrapped in pastel haze and drifting dust.",
    steps: [
      { id: "scaleIn" },
      { id: "dreamy" },
      { id: "floatingDust" },
    ],
    thumb: "fxt-cmb-dream",
  },
  {
    id: "dramaticExit",
    label: "Dramatic Exit",
    description: "Emulsion burn-out on a moody grade.",
    steps: [
      { id: "filmBurn", window: "end" },
      { id: "darkMood" },
    ],
    thumb: "fxt-cmb-burn",
  },
  {
    id: "crtSignOff",
    label: "CRT Sign-off",
    description: "Broadcast-death collapse in stark monochrome.",
    steps: [
      { id: "signalOff", window: "end" },
      { id: "monochrome" },
    ],
    thumb: "fxt-cmb-crt",
  },
];

export const comboPreset = (id: string) => COMBO_PRESETS.find((c) => c.id === id);

const defaultsOf = (id: string) =>
  Object.fromEntries((fxEntry(id)?.params ?? []).map((p) => [p.key, p.def]));

/**
 * Apply a combo to `clip`. Returns the mutated doc, or the original doc
 * when nothing applied (unknown id / every step unsupported).
 * Filter steps respect the 3-active-filter cap — extra ones are skipped.
 */
export function applyCombo(
  doc: ProjectDoc,
  clip: Clip,
  comboId: string,
  opts: { durationMs?: number; versionId?: string | null } = {},
): { doc: ProjectDoc; applied: number } {
  const combo = comboPreset(comboId);
  if (!combo) return { doc, applied: 0 };
  let d = doc;
  let applied = 0;
  for (const step of combo.steps) {
    const entry = fxEntry(step.id);
    if (entry && (entry.kind === "effect" || entry.kind === "filter")) {
      const isFilter = entry.kind === "filter";
      const target = d.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === clip.id);
      if (!target) break;
      if (isFilter) {
        const active = target.effects.filter(
          (x) => x.enabled && fxEntry(x.type)?.kind === "filter",
        ).length;
        if (active >= 3) continue;
      }
      const dur = entry.params.find((p) => p.key === "duration")?.def ?? 800;
      const wMs = Math.min(dur, target.durationMs);
      d = addEffect(d, target.id, {
        id: crypto.randomUUID(),
        type: entry.id,
        enabled: true,
        params: defaultsOf(entry.id),
        inMs: step.window === "end" ? Math.max(0, target.durationMs - wMs) : 0,
        outMs: step.window === "start" ? wMs : undefined,
      });
      applied += 1;
      continue;
    }
    // Anim preset step — bakes its own keyframe paths, stays removable
    // via the keyframe editor / preset re-apply.
    if (animPreset(step.id)) {
      d = applyAnimationPreset(d, clip.id, step.id, {
        durationMs:
          opts.durationMs ??
          Math.min(600, Math.max(100, clip.durationMs / 2)),
        versionId: opts.versionId,
      });
      applied += 1;
    }
  }
  return { doc: d, applied };
}
