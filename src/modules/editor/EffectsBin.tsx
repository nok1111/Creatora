import type { LucideIcon } from "lucide-react";
import {
  Blend,
  CircleDashed,
  Contrast,
  Droplets,
  Expand,
  Eye,
  LogIn,
  LogOut,
  MoveHorizontal,
  MoveRight,
  RotateCw,
  Sparkles,
  Sun,
  Thermometer,
  Wand2,
  Zap,
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

const CATALOG: { id: EffectCategory; labelKey: string; icon: LucideIcon; items: FxItem[] }[] = [
  {
    id: "start",
    labelKey: "editor.fxCatStart",
    icon: LogIn,
    items: [
      preset("fadeIn", Eye),
      preset("scaleIn", Expand),
      preset("slideIn", MoveRight),
      preset("rotateIn", RotateCw),
      preset("blurIn", Droplets),
    ],
  },
  {
    id: "end",
    labelKey: "editor.fxCatEnd",
    icon: LogOut,
    items: [
      preset("fadeOut", Eye),
      preset("slideOut", MoveRight),
      preset("blurOut", Droplets),
    ],
  },
  {
    id: "merge",
    labelKey: "editor.fxCatMerge",
    icon: Blend,
    items: [
      { id: "crossfade", label: "Crossfade", icon: Blend },
      { id: "dipToBlack", label: "Dip to black", icon: CircleDashed },
      { id: "dipToWhite", label: "Dip to white", icon: CircleDashed },
    ],
  },
  {
    id: "overlay",
    labelKey: "editor.fxCatOverlay",
    icon: Wand2,
    items: EFFECTS.map((e) => ({
      id: e.type,
      label: e.label,
      icon:
        e.type === "blur" ? Droplets :
        e.type === "temperature" ? Thermometer :
        e.type === "saturation" ? Sparkles :
        e.type === "contrast" ? Contrast :
        e.type === "exposure" ? Zap :
        e.type === "brightness" ? Sun : MoveHorizontal,
    })),
  },
];

export function EffectsBin() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {CATALOG.map((cat) => (
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
