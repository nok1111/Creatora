/** Centralized subtitle style presets — mirror applied to ASS burn-in and
 * preview through the same SubtitleStyle model (ADR-025).
 *
 * The set mirrors the caption looks most used on TikTok / Reels / Shorts:
 * Hormozi-style highlight fills, Beast-style chunky comic caps, clean
 * lowercase creator captions, native-app boxed text, meme/POV headers…
 * `fontName` refers to a system family (no file shipped). */
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
  fontName: null,
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
  // ── High-energy creator looks ───────────────────────────────────────
  {
    id: "hormozi",
    label: "Hormozi",
    style: {
      text: base(52, "#FFFFFF", {
        fontName: "Arial Black",
        outlineColor: "#000000",
        outlineWidth: 5,
        alignV: "middle",
      }),
      highlightColor: "#FFE234",
      mode: "karaoke",
      marginVPx: 40,
      marginHPx: 32,
    },
  },
  {
    id: "hormozi-slam",
    label: "Hormozi Slam",
    style: {
      text: base(56, "#FFFFFF", {
        fontName: "Arial Black",
        outlineColor: "#000000",
        outlineWidth: 5,
        alignV: "middle",
      }),
      highlightColor: "#FFE234",
      mode: "impact",
      marginVPx: 36,
      marginHPx: 28,
    },
  },
  {
    id: "beast",
    label: "Beast",
    style: {
      text: base(54, "#FFFFFF", {
        fontName: "Impact",
        outlineColor: "#000000",
        outlineWidth: 6,
        alignV: "middle",
      }),
      highlightColor: "#FF3131",
      mode: "jump",
      marginVPx: 40,
      marginHPx: 30,
    },
  },
  {
    id: "beast-glow",
    label: "Beast Glow",
    style: {
      text: base(54, "#FFFFFF", {
        fontName: "Impact",
        outlineColor: "#000000",
        outlineWidth: 5,
        alignV: "middle",
      }),
      highlightColor: "#39FF14",
      mode: "jump",
      marginVPx: 40,
      marginHPx: 30,
    },
  },
  {
    id: "pop-stroke",
    label: "Pop Stroke",
    style: {
      text: base(50, "#FFFFFF", {
        fontName: "Arial Black",
        outlineColor: "#FF3131",
        outlineWidth: 5,
        alignV: "middle",
      }),
      highlightColor: "#FFE234",
      mode: "pop",
      marginVPx: 40,
      marginHPx: 32,
    },
  },
  {
    id: "boxed",
    label: "Boxed",
    style: {
      text: base(46, "#FFFFFF", {
        fontName: "Arial Black",
        backgroundColor: "#000000E6",
        backgroundPadPx: 16,
        alignV: "middle",
      }),
      highlightColor: "#00E5FF",
      mode: "karaoke",
      marginVPx: 44,
      marginHPx: 40,
    },
  },
  {
    id: "sticker",
    label: "Sticker",
    style: {
      text: base(46, "#111111", {
        fontName: "Arial Black",
        backgroundColor: "#FFFFFFF2",
        backgroundPadPx: 14,
        shadowColor: "#00000059",
        shadowX: 3,
        shadowY: 3,
        alignV: "middle",
      }),
      highlightColor: "#FF3131",
      mode: "pop",
      marginVPx: 44,
      marginHPx: 40,
    },
  },
  {
    id: "bubblegum",
    label: "Bubblegum",
    style: {
      text: base(50, "#FF7AD9", {
        fontName: "Arial Black",
        outlineColor: "#FFFFFF",
        outlineWidth: 3,
        shadowColor: "#B5179E",
        shadowX: 4,
        shadowY: 4,
        alignV: "middle",
      }),
      highlightColor: "#FFFFFF",
      mode: "jump",
      marginVPx: 40,
      marginHPx: 32,
    },
  },
  {
    id: "neon-glow",
    label: "Neon Glow",
    style: {
      text: base(46, "#FFFFFF", {
        fontName: "Arial Black",
        outlineColor: "#00E5FF",
        outlineWidth: 2,
        backgroundColor: "#0D0D12E6",
        backgroundPadPx: 14,
        alignV: "middle",
      }),
      highlightColor: "#00E5FF",
      mode: "karaoke",
      marginVPx: 44,
      marginHPx: 40,
    },
  },
  // ── Clean / understated creator looks ───────────────────────────────
  {
    id: "iman-clean",
    label: "Iman Clean",
    style: {
      text: base(40, "#D9D9D9", {
        fontName: "Segoe UI",
        shadowColor: "#00000080",
        shadowX: 0,
        shadowY: 2,
        alignV: "middle",
      }),
      highlightColor: "#FFFFFF",
      mode: "karaoke",
      marginVPx: 48,
      marginHPx: 48,
    },
  },
  {
    id: "ali-notes",
    label: "Ali Notes",
    style: {
      text: base(30, "#ECECEC", {
        fontName: "Segoe UI",
        shadowColor: "#00000066",
        shadowX: 0,
        shadowY: 1,
      }),
      highlightColor: "#FFC53D",
      mode: "karaoke",
      marginVPx: 56,
      marginHPx: 56,
    },
  },
  {
    id: "modern",
    label: "Modern Clean",
    style: {
      text: base(30, "#F5F5F5", {
        fontName: "Segoe UI",
        outlineColor: "#000000",
        outlineWidth: 1,
      }),
      highlightColor: "#8AB4FF",
      mode: "none",
      marginVPx: 64,
      marginHPx: 56,
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    style: {
      text: base(26, "#E8E8E8", { fontName: "Segoe UI" }),
      highlightColor: "#FFFFFF",
      mode: "none",
      marginVPx: 32,
      marginHPx: 48,
    },
  },
  {
    id: "elegant-serif",
    label: "Elegant Serif",
    style: {
      text: base(38, "#F8F4E8", {
        fontName: "Georgia",
        shadowColor: "#00000099",
        shadowX: 0,
        shadowY: 2,
      }),
      highlightColor: "#FFD28A",
      mode: "none",
      marginVPx: 64,
      marginHPx: 56,
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
    id: "typewriter",
    label: "Typewriter",
    style: {
      text: base(34, "#E8E8E8", {
        fontName: "Courier New",
        backgroundColor: "#00000080",
        backgroundPadPx: 10,
      }),
      highlightColor: "#7CFC00",
      mode: "none",
      marginVPx: 48,
      marginHPx: 48,
    },
  },
  // ── Platform-native looks ───────────────────────────────────────────
  {
    id: "tiktok-native",
    label: "TikTok Native",
    style: {
      text: base(34, "#FFFFFF", {
        fontName: "Segoe UI",
        backgroundColor: "#000000B3",
        backgroundPadPx: 10,
      }),
      highlightColor: "#FFFFFF",
      mode: "none",
      marginVPx: 72,
      marginHPx: 48,
    },
  },
  {
    id: "tiktok-yellow",
    label: "TikTok Yellow",
    style: {
      text: base(44, "#FFE234", {
        fontName: "Arial Black",
        outlineColor: "#000000",
        outlineWidth: 4,
      }),
      highlightColor: "#FFFFFF",
      mode: "none",
      marginVPx: 72,
      marginHPx: 40,
    },
  },
  {
    id: "karaoke-yellow",
    label: "Karaoke Yellow",
    style: {
      text: base(44, "#FFFFFF", {
        fontName: "Arial Black",
        outlineColor: "#000000",
        outlineWidth: 3,
      }),
      highlightColor: "#FFE234",
      mode: "karaoke",
      marginVPx: 48,
      marginHPx: 40,
    },
  },
  {
    id: "meme-pov",
    label: "Meme / POV",
    style: {
      text: base(44, "#FFFFFF", {
        fontName: "Impact",
        outlineColor: "#000000",
        outlineWidth: 4,
        shadowColor: "#000000",
        shadowX: 3,
        shadowY: 3,
        alignV: "top",
      }),
      highlightColor: "#FFE234",
      mode: "none",
      marginVPx: 40,
      marginHPx: 32,
    },
  },
  // ── Legacy set ──────────────────────────────────────────────────────
  {
    id: "classic",
    label: "Classic",
    style: {
      text: base(32, "#FFFFFF", { outlineColor: "#000000", outlineWidth: 2 }),
      highlightColor: "#00E5FF",
      mode: "none",
      marginVPx: 48,
      marginHPx: 40,
    },
  },
  {
    id: "bold-social",
    label: "Bold Social",
    style: {
      text: base(52, "#FFFFFF", {
        fontName: "Arial Black",
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
    id: "jumpy",
    label: "Jumpy",
    style: {
      text: base(48, "#FFFFFF", {
        fontName: "Arial Black",
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
        fontName: "Impact",
        outlineColor: "#000000",
        outlineWidth: 5,
        alignV: "middle",
      }),
      highlightColor: "#FFE234",
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
