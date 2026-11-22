import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Clapperboard, Undo2 } from "lucide-react";
import { useProject } from "@/stores/project";
import { requestProjectSwitch } from "@/services/project-switch";
import { FormatArt, type FormatTone } from "@/components/FormatArt";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";

/** Guided creation — /create. Two steps: pick a format, name it, edit. */

const FORMATS = [
  { id: "yt", label: "YouTube video", hint: "Horizontal · 16:9", w: 1920, h: 1080,
    art: "primary", dashed: false, tone: "border-primary/40 text-primary" },
  { id: "vert", label: "Short / Reel / TikTok", hint: "Vertical · 9:16", w: 1080, h: 1920,
    art: "lavender", dashed: false, tone: "border-accent text-accent-foreground" },
  { id: "sq", label: "Square post", hint: "Square · 1:1", w: 1080, h: 1080,
    art: "lime", dashed: false, tone: "border-success/40 text-success" },
  { id: "uhd", label: "4K UHD", hint: "Horizontal · 16:9", w: 3840, h: 2160,
    art: "primary", dashed: false, tone: "border-primary/40 text-primary" },
  { id: "custom", label: "Custom format", hint: "Any size", w: 1280, h: 720,
    art: "muted", dashed: true, tone: "border-border text-muted-foreground" },
] as const;

export function CreatePage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const createNew = useProject((s) => s.createNew);
  const doc = useProject((s) => s.doc);
  const dirty = useProject((s) => s.dirty);
  const initial = FORMATS.some((f) => f.id === params.get("format"))
    ? (params.get("format") as (typeof FORMATS)[number]["id"])
    : "vert";
  const [fmt, setFmt] = useState<(typeof FORMATS)[number]["id"]>(initial);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [fps, setFps] = useState(30);

  const selected = FORMATS.find((f) => f.id === fmt)!;
  const dims = fmt === "custom" && size ? size : { w: selected.w, h: selected.h };

  // Empty name → "Untitled · 9:16" so a list of untitled projects is
  // still distinguishable by the format the user picked.
  const untitledName = () => {
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const d = g(dims.w, dims.h);
    return `${t("create.untitled")} · ${dims.w / d}:${dims.h / d}`;
  };

  const create = () => {
    const n = name.trim() || untitledName();
    requestProjectSwitch(async () => {
      setBusy(true);
      try {
        await createNew({ name: n, width: dims.w, height: dims.h, fpsNum: fps, fpsDen: 1 });
        nav("/editor");
      } catch (e) {
        reportError(e);
        setBusy(false);
      }
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">{t("create.whatMaking")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a format — you can change it or add more inside the editor.
        </p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFmt(f.id)}
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border-2 bg-surface-2 p-5 shadow-raise transition-all",
              fmt === f.id ? f.tone + " shadow-lift scale-[1.02]" : "border-border hover:border-muted-foreground/50",
            )}
          >
            <div className="flex h-14 items-center justify-center">
              <FormatArt w={f.w} h={f.h} tone={f.art as FormatTone} dashed={f.dashed} height={56} />
            </div>
            <div className="text-center">
              <div className="text-sm font-semibold leading-tight">{f.label}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{f.hint}</div>
            </div>
          </button>
        ))}
      </div>

      {fmt === "custom" && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-1 p-4 text-sm">
          <span className="text-muted-foreground">{t("create.size")}</span>
          <input
            className="w-20 rounded-md border border-input bg-surface-0 px-2 py-1 text-center"
            defaultValue={1280}
            onChange={(e) => setSize({ w: +e.target.value || 1280, h: size?.h ?? 720 })}
          />
          ×
          <input
            className="w-20 rounded-md border border-input bg-surface-0 px-2 py-1 text-center"
            defaultValue={720}
            onChange={(e) => setSize({ w: size?.w ?? 1280, h: +e.target.value || 720 })}
          />
          <span className="text-xs text-muted-foreground">px</span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-1 p-1">
          {[24, 30, 60].map((f) => (
            <button
              key={f}
              onClick={() => setFps(f)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                fps === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f}
            </button>
          ))}
          <span className="pr-1.5 text-[10px] text-muted-foreground">fps</span>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder={t("create.namePh")}
          className="h-11 flex-1 rounded-xl border border-input bg-surface-1 px-4 text-sm shadow-raise outline-none focus:border-primary"
        />
        <button
          onClick={() => void create()}
          disabled={busy}
          className="flex h-11 items-center gap-2 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-raise transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50"
        >
          {busy ? t("create.creating") : t("create.startEditing")} <ArrowRight className="size-4" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("create.nextStep")}
      </p>

      {doc && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-1 px-4 py-3 shadow-raise">
          <div className="flex min-w-0 items-center gap-3">
            <Clapperboard className="size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("create.editingNow")}
              </div>
              <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                <span className="truncate">{doc.meta?.name}</span>
                {dirty && <span title={t("common.unsaved")} className="size-1.5 shrink-0 rounded-full bg-warning" />}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {doc.canvas.width}×{doc.canvas.height}
              </div>
            </div>
          </div>
          <button
            onClick={() => nav("/editor")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary/50 hover:text-primary"
          >
            <Undo2 className="size-3.5" /> {t("create.backToEditor")}
          </button>
        </div>
      )}
    </div>
  );
}
