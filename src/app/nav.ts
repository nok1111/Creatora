import {
  Home,
  Rocket,
  FolderOpen,
  Clapperboard,
  Share2,
  BarChart3,
  Scissors,
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
  { key: "library", path: "/library", icon: FolderOpen, phase: 2, implemented: true },
  { key: "repurpose", path: "/repurpose", icon: Scissors, phase: 11, implemented: true },
  { key: "editor", path: "/create", icon: Clapperboard, phase: 3, implemented: true },
  { key: "exports", path: "/exports", icon: Rocket, phase: 10, implemented: true },
  { key: "social", path: "/social", icon: Share2, phase: 8, implemented: true },
  { key: "analytics", path: "/analytics", icon: BarChart3, phase: 9, implemented: true },
  { key: "settings", path: "/settings", icon: Settings, phase: 1, implemented: true },
];
