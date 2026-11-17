/** Centralized subtitle style presets — mirror applied to ASS burn-in and
 * preview through the same SubtitleStyle model (ADR-025). */
import type { SubtitleStyle } from "./project-types";

export interface SubtitlePreset {
  id: string;
  label: string;
  style: SubtitleStyle;
}

const base = (
  fontSizePx: number,
  color: string,
  extra: Partial<SubtitleStyle["text"]> = {},
): SubtitleStyle["text"] => ({
  fontFile: null,
  fontSizePx,
  color,
  outlineColor: null,
  outlineWidth: 0,
  backgroundColor: null,
  backgroundPadPx: 8,
  alignH: "center",
  alignV: "bottom",
  ...extra,
});

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  {
    id: "classic",
    label: "Classic Subtitles",
    style: {
      text: base(32, "#FFFFFF", { outlineColor: "#000000", outlineWidth: 2 }),
      highlightColor: "#00E5FF",
      mode: "none",
      marginVPx: 48,
      marginHPx: 40,
    },
  },
  {
    id: "modern",
    label: "Modern Clean",
    style: {
      text: base(30, "#F5F5F5", { outlineColor: "#000000", outlineWidth: 1 }),
      highlightColor: "#8AB4FF",
      mode: "none",
      marginVPx: 64,
      marginHPx: 56,
    },
  },
  {
    id: "bold-social",
    label: "Bold Social",
    style: {
      text: base(52, "#FFFFFF", {
        outlineColor: "#000000",
        outlineWidth: 4,
        alignV: "middle",
      }),
      highlightColor: "#FFE234",
      mode: "pop",
      marginVPx: 40,
      marginHPx: 32,
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    style: {
      text: base(26, "#E8E8E8"),
      highlightColor: "#FFFFFF",
      mode: "none",
      marginVPx: 32,
      marginHPx: 48,
    },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    style: {
      text: base(36, "#F8F4E8", { outlineColor: "#000000", outlineWidth: 2 }),
      highlightColor: "#FFD28A",
      mode: "karaoke",
      marginVPx: 96,
      marginHPx: 64,
    },
  },
  {
    id: "jumpy",
    label: "Jumpy",
    style: {
      text: base(48, "#FFFFFF", {
        outlineColor: "#000000",
        outlineWidth: 4,
        alignV: "middle",
      }),
      highlightColor: "#FF3D81",
      mode: "jump",
      marginVPx: 40,
      marginHPx: 32,
    },
  },
  {
    id: "impact",
    label: "Impact",
    style: {
      text: base(56, "#FFE234", {
        outlineColor: "#000000",
        outlineWidth: 5,
        alignV: "middle",
      }),
      highlightColor: "#FFFFFF",
      mode: "impact",
      marginVPx: 36,
      marginHPx: 28,
    },
  },
  {
    id: "creator-highlight",
    label: "Creator Highlight",
    style: {
      text: base(44, "#FFFFFF", {
        outlineColor: "#111111",
        outlineWidth: 3,
        backgroundColor: "#000000B3",
        alignV: "middle",
      }),
      highlightColor: "#00E5FF",
      mode: "karaoke",
      marginVPx: 40,
      marginHPx: 40,
    },
  },
];

export function subtitlePreset(id: string): SubtitlePreset | undefined {
  return SUBTITLE_PRESETS.find((p) => p.id === id);
}
