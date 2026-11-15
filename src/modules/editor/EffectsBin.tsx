import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Aperture,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Blend,
  BringToFront,
  Circle,
  CircleDashed,
  CircleDot,
  Columns2,
  Columns3,
  Combine,
  Contrast,
  Droplets,
  Eraser,
  Expand,
  Eye,
  Film,
  FoldVertical,
  Grid3x3,
  LogIn,
  LogOut,
  Moon,
  MoveDown,
  MoveLeft,
  MoveRight,
  MoveUp,
  Palette,
  RefreshCw,
  Repeat,
  RotateCw,
  Rows2,
  Scan,
  Shrink,
  Shuffle,
  Sparkles,
  Sun,
  SunMoon,
  Target,
  Thermometer,
  Type,
  UnfoldVertical,
  Wand2,
  Waves,
  Wind,
  Zap,
  ZoomIn,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { setDragPayload, type EffectCategory } from "@/lib/drag-payload";
import { EFFECTS } from "@/lib/effects";
import { ANIM_PRESETS } from "@/lib/anim-presets";

/**
 * Effects library — draggable tiles applied to timeline clips on drop.
 *
 * Every tile maps to a render-supported primitive, so preview ≈ export:
 *  - start/end  → animation presets (baked transform/opacity keyframes or
 *                 textFx for text/graphics clips), ADR-027
 *  - merge      → track.transitions (ffmpeg xfade)
 *  - overlay    → clip.effects entries (CSS / SVG-matrix + ffmpeg parity)
 */

interface FxItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** i18n description key under editor.fxDesc.* — optional. */
  descKey?: string;
}

const preset = (id: string, icon: LucideIcon): FxItem => ({
  id,
  icon,
  label: ANIM_PRESETS.find((p) => p.id === id)?.label ?? id,
});

const OVERLAY_ICONS: Record<string, LucideIcon> = {
  brightness: Sun,
  exposure: Zap,
  contrast: Contrast,
  saturation: Sparkles,
  temperature: Thermometer,
  blur: Droplets,
  grayscale: Moon,
  sepia: SunMoon,
  invert: RefreshCw,
  hueRotate: Palette,
  sharpen: Aperture,
  vignette: CircleDot,
  grain: Film,
};

const tr = (id: string, label: string, icon: LucideIcon): FxItem => ({ id, label, icon });

/** Exported so the fx-catalog audit test iterates the same tiles the UI
    renders — a tile that maps to nothing is a test failure, not a silent
    no-op. */
export const FX_CATALOG: { id: EffectCategory; labelKey: string; icon: LucideIcon; items: FxItem[] }[] = [
  {
    id: "start",
    labelKey: "editor.fxCatStart",
    icon: LogIn,
    items: [
      preset("fadeIn", Eye),
      preset("scaleIn", Expand),
      preset("bounceIn", Activity),
      preset("spinIn", RefreshCw),
      preset("slideIn", MoveRight),
      preset("rotateIn", RotateCw),
      preset("blurIn", Droplets),
      preset("typewriter", Type),
      preset("wipe", Eraser),
    ],
  },
  {
    id: "end",
    labelKey: "editor.fxCatEnd",
    icon: LogOut,
    items: [
      preset("fadeOut", Eye),
      preset("scaleOut", Shrink),
      preset("slideOut", MoveLeft),
      preset("rotateOut", RotateCw),
      preset("blurOut", Droplets),
      preset("typewriterOut", Type),
      preset("wipeOut", Eraser),
    ],
  },
  {
    id: "merge",
    labelKey: "editor.fxCatMerge",
    icon: Blend,
    items: [
      tr("crossfade", "Crossfade", Blend),
      tr("dipToBlack", "Dip to black", Moon),
      tr("dipToWhite", "Dip to white", Sun),
      tr("fadegrays", "Grays fade", SunMoon),
      tr("dissolve", "Dissolve", Shuffle),
      tr("pixelize", "Pixelize", Grid3x3),
      tr("hblur", "Blur dissolve", Waves),
      tr("zoomin", "Zoom", ZoomIn),
      tr("radial", "Radial", Target),
      tr("circleopen", "Circle open", Circle),
      tr("circleclose", "Circle close", CircleDot),
      tr("circlecrop", "Circle crop", CircleDashed),
      tr("wipeleft", "Wipe left", ArrowLeft),
      tr("wiperight", "Wipe right", ArrowRight),
      tr("wipeup", "Wipe up", ArrowUp),
      tr("wipedown", "Wipe down", ArrowDown),
      tr("wipetl", "Wipe corner", ArrowUpLeft),
      tr("diagtr", "Diagonal", ArrowUpRight),
      tr("slideleft", "Slide left", MoveLeft),
      tr("slideright", "Slide right", MoveRight),
      tr("slideup", "Slide up", MoveUp),
      tr("slidedown", "Slide down", MoveDown),
      tr("smoothleft", "Smooth left", ArrowLeft),
      tr("smoothright", "Smooth right", ArrowRight),
      tr("coverleft", "Cover left", BringToFront),
      tr("coverup", "Cover up", BringToFront),
      tr("revealleft", "Reveal left", Scan),
      tr("revealright", "Reveal right", Scan),
      tr("revealup", "Reveal up", Scan),
      tr("squeezeh", "Squeeze", FoldVertical),
      tr("vertopen", "Vertical open", UnfoldVertical),
      tr("horzclose", "Horizontal close", Combine),
      tr("hlslice", "Blinds", Columns3),
      tr("vuslice", "Venetian up", Rows2),
      tr("vdslice", "Venetian down", Columns2),
    ],
  },
  {
    id: "overlay",
    labelKey: "editor.fxCatOverlay",
    icon: Wand2,
    items: [
      ...EFFECTS.map((e) => ({
        id: e.type,
        label: e.label,
        icon: OVERLAY_ICONS[e.type] ?? Wand2,
      })),
      // Combo/emphasis/loop animation presets — the drop handler routes
      // any ANIM_PRESETS id to the keyframe path regardless of category.
      preset("fadeInOut", Repeat),
      preset("slideInOut", Repeat),
      preset("scaleInOut", Repeat),
      preset("pulse", Activity),
      preset("shake", Waves),
      preset("float", Wind),
    ],
  },
];

export function EffectsBin() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {FX_CATALOG.map((cat) => (
        <div key={cat.id} className="border-b border-border/60">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <cat.icon className="size-3" />
            {t(cat.labelKey)}
          </div>
          <div className="grid grid-cols-2 gap-1 px-2 pb-2">
            {cat.items.map((item) => (
              <div
                key={item.id}
                draggable
                title={t("editor.fxDragHint")}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    "application/x-creatora-effect",
                    JSON.stringify({ category: cat.id, itemId: item.id }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                  setDragPayload({ effect: true, category: cat.id, itemId: item.id });
                }}
                onDragEnd={() => setDragPayload(null)}
                className="flex cursor-grab items-center gap-1.5 rounded border border-border bg-background/60 px-1.5 py-1.5 text-[11px] hover:border-primary/50 hover:bg-accent active:cursor-grabbing"
              >
                <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="px-2.5 py-2 text-[10px] leading-snug text-muted-foreground/70">
        {t("editor.fxBinFooter")}
      </p>
    </div>
  );
}
