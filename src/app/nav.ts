import {
  Home,
  FolderOpen,
  Clapperboard,
  RectangleHorizontal,
  Captions,
  AudioLines,
  Image,
  Palette,
  Share2,
  CalendarDays,
  BarChart3,
  Rocket,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { en } from "@/i18n/locales/en";

export type NavKey = keyof typeof en.nav;

export interface ModuleDef {
  key: NavKey;
  path: string;
  icon: LucideIcon;
  /** Dev-plan phase where this module is implemented. */
  phase: number;
  implemented: boolean;
}

/**
 * Single source of truth for module routing + sidebar.
 * Order here = sidebar order.
 */
export const MODULES: ModuleDef[] = [
  { key: "home", path: "/", icon: Home, phase: 2, implemented: true },
  { key: "library", path: "/library", icon: FolderOpen, phase: 2, implemented: false },
  { key: "editor", path: "/editor", icon: Clapperboard, phase: 3, implemented: true },
  { key: "formats", path: "/formats", icon: RectangleHorizontal, phase: 4, implemented: false },
  { key: "subtitles", path: "/subtitles", icon: Captions, phase: 5, implemented: false },
  { key: "audio", path: "/audio", icon: AudioLines, phase: 5, implemented: false },
  { key: "graphics", path: "/graphics", icon: Image, phase: 6, implemented: false },
  { key: "brand", path: "/brand", icon: Palette, phase: 6, implemented: false },
  { key: "social", path: "/social", icon: Share2, phase: 8, implemented: false },
  { key: "planner", path: "/planner", icon: CalendarDays, phase: 9, implemented: false },
  { key: "analytics", path: "/analytics", icon: BarChart3, phase: 9, implemented: false },
  { key: "export", path: "/export", icon: Rocket, phase: 7, implemented: false },
  { key: "settings", path: "/settings", icon: Settings, phase: 1, implemented: true },
];
