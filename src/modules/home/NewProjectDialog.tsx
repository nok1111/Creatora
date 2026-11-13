import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProject } from "@/stores/project";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface Preset {
  key: string;
  label: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

const PRESETS: Preset[] = [
  { key: "yt1080", label: "YouTube · 1920×1080 · 30", width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
  { key: "yt4k", label: "YouTube 4K · 3840×2160 · 30", width: 3840, height: 2160, fpsNum: 30, fpsDen: 1 },
  { key: "vertical", label: "Vertical · 1080×1920 · 30", width: 1080, height: 1920, fpsNum: 30, fpsDen: 1 },
  { key: "square", label: "Square · 1080×1080 · 30", width: 1080, height: 1080, fpsNum: 30, fpsDen: 1 },
  { key: "yt60", label: "YouTube · 1920×1080 · 60", width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 },
  { key: "custom", label: "Custom", width: 0, height: 0, fpsNum: 30, fpsDen: 1 },
];

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const createNew = useProject((s) => s.createNew);
  const [name, setName] = useState("");
  const [presetIdx, setPresetIdx] = useState(0);
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [fps, setFps] = useState("30");
  const [busy, setBusy] = useState(false);

  const preset = PRESETS[presetIdx];
  const isCustom = preset.key === "custom";

  const selectPreset = (i: number) => {
    setPresetIdx(i);
    const p = PRESETS[i];
    if (p.key !== "custom") {
      setWidth(String(p.width));
      setHeight(String(p.height));
      setFps(String(p.fpsNum));
    }
  };

  const submit = async () => {
    const w = Number.parseInt(width, 10);
    const h = Number.parseInt(height, 10);
    const f = Number.parseInt(fps, 10);
    if (!name.trim() || !w || !h || !f) {
      toast.error(t("home.newProjectInvalid"));
      return;
    }
    setBusy(true);
    try {
      await createNew({ name: name.trim(), width: w, height: h, fpsNum: f, fpsDen: 1 });
      toast.success(t("home.projectCreated", { name: name.trim() }));
      onOpenChange(false);
      setName("");
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("home.newProject")}</DialogTitle>
          <DialogDescription>{t("home.newProjectDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="np-name">{t("home.projectName")}</Label>
            <Input
              id="np-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("home.projectNamePlaceholder")}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("home.preset")}</Label>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p, i) => (
                <button
                  key={p.key}
                  onClick={() => selectPreset(i)}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-xs transition-colors",
                    i === presetIdx
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-border text-muted-foreground hover:border-input hover:text-foreground",
                  )}
                >
                  {p.key === "custom" ? t("home.presetCustom") : p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-w">{t("home.width")}</Label>
              <Input id="np-w" value={width} disabled={!isCustom} onChange={(e) => setWidth(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-h">{t("home.height")}</Label>
              <Input id="np-h" value={height} disabled={!isCustom} onChange={(e) => setHeight(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-f">{t("home.fps")}</Label>
              <Input id="np-f" value={fps} disabled={!isCustom} onChange={(e) => setFps(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
            {t("home.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
