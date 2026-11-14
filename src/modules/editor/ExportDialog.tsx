import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronDown,
  FileVideo,
  FolderOpen,
  Gauge,
  Gem,
  Loader2,
  Rocket,
  XCircle,
  Zap,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/ipc";
import { awaitJob, onJobProgress, primeJobListeners } from "@/services/jobs";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import { getVersion, timelineDuration } from "@/lib/timeline-engine";
import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_MATRIX,
  validateExportSettings,
  type ExportSettings,
} from "@/lib/project-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Phase = "config" | "running" | "done" | "failed" | "cancelled";

const PRESETS = [
  {
    key: "fast",
    icon: Zap,
    preset: "faster",
    crf: 23,
  },
  {
    key: "balanced",
    icon: Gauge,
    preset: "veryfast",
    crf: 20,
  },
  {
    key: "quality",
    icon: Gem,
    preset: "medium",
    crf: 18,
  },
] as const;

/** Small block showing the real aspect ratio. */
function AspectTile({ w, h }: { w: number; h: number }) {
  const portrait = h > w;
  const bw = portrait ? 22 : 36;
  const bh = portrait ? 36 : Math.max(18, Math.round((36 * h) / w));
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-[9px] font-semibold text-primary"
      style={{ width: bw + 8, height: bh + 8 }}
    >
      {w / d}:{h / d}
    </span>
  );
}

/**
 * Export Dialog (Fase 1): friendly preset cards on top, full encoder
 * matrix folded under "Advanced", real job progress + cancel, and a
 * clear result state. Settings for versions persist on the version
 * (same field VersionsPanel edits); master's choice is passed to the
 * export job directly — the project format doesn't grow a field.
 */
export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const filePath = useProject((s) => s.filePath);
  const save = useProject((s) => s.save);
  const mutate = useEditor((s) => s.mutate);
  const activeVersionId = useEditor((s) => s.activeVersionId);

  const [phase, setPhase] = useState<Phase>("config");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outPath, setOutPath] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [presetKey, setPresetKey] = useState<string | null>("balanced");
  const [cfg, setCfg] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);

  const version = useMemo(
    () => (doc && activeVersionId ? getVersion(doc, activeVersionId) : undefined),
    [doc, activeVersionId],
  );

  // Sync config with the active version when the dialog opens.
  useEffect(() => {
    if (!open || !doc) return;
    const base = version?.export ?? DEFAULT_EXPORT_SETTINGS;
    setCfg({ ...base });
    setPresetKey(null);
    setPhase("config");
    setProgress(0);
    setError(null);
    setOutPath(null);
    setJobId(null);
  }, [open, doc, version?.id]);

  if (!doc) return null;

  const canvas = version?.canvas ?? doc.canvas;
  const durationMs = timelineDuration(doc);
  const ratioStr = (() => {
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const d = g(canvas.width, canvas.height);
    return `${canvas.width / d}:${canvas.height / d}`;
  })();
  const err = validateExportSettings(cfg);
  const secs = Math.round(durationMs / 1000);

  const patch = (p: Partial<ExportSettings>) => {
    setCfg((c) => ({ ...c, ...p }));
    // Manual tweaks detach the friendly preset label — the numbers
    // shown below the cards always reflect what will actually encode.
    setPresetKey(null);
  };

  const pickPreset = (k: (typeof PRESETS)[number]) => {
    setPresetKey(k.key);
    setCfg((c) => ({ ...c, preset: k.preset, crf: k.crf, videoBitrate: null }));
  };

  const pickContainer = (container: string) => {
    patch({
      container,
      // Keep codec/audio legal for the container (validate_export rules).
      codec: container === "webm" ? "libvpx-vp9" : cfg.codec === "libvpx-vp9" ? "libx264" : cfg.codec,
      audioCodec:
        container === "webm"
          ? cfg.audioCodec === "none"
            ? "none"
            : "libopus"
          : cfg.audioCodec === "libopus"
            ? "aac"
            : cfg.audioCodec,
    });
  };

  const start = async () => {
    if (!filePath || err) return;
    const out = await saveDialog({
      title: t("exportDlg.chooseDest"),
      defaultPath: `${doc.meta.name ?? "export"}-${version?.name ?? "master"}.${cfg.container}`,
      filters: [{ name: cfg.container.toUpperCase(), extensions: [cfg.container] }],
    });
    if (!out) return;
    try {
      // Listeners must exist before the job starts — a fast-failing job
      // would otherwise emit job://finished before listen() registered.
      await primeJobListeners();
      // Versions persist the chosen settings on the version itself — same
      // field the Multi-Format strip edits. Master has no field, so its
      // settings travel with the job (export_project `settings` param).
      if (version) {
        mutate((d) => {
          const n = structuredClone(d);
          const vv = n.versions.find((x) => x.id === version.id);
          if (vv) vv.export = { ...cfg };
          return n;
        });
      }
      await save();
      const id = await api.exportProject(
        filePath,
        out,
        version?.id,
        version ? undefined : cfg,
      );
      setJobId(id);
      setOutPath(out);
      setPhase("running");
      setProgress(0);
      const off = onJobProgress((p) => {
        if (p.jobId === id) setProgress(p.progress);
      });
      const fin = await awaitJob<{ outputPath: string; skippedClips: number }>(id);
      off();
      setJobId(null);
      if (fin.status === "done") {
        setSkipped(fin.result?.skippedClips ?? 0);
        setPhase("done");
      } else if (fin.status === "cancelled") {
        setPhase("cancelled");
      } else {
        setError(fin.error ?? t("exportDlg.failedGeneric"));
        setPhase("failed");
      }
    } catch (e) {
      setError(String(e));
      setPhase("failed");
    }
  };

  const cancel = async () => {
    if (!jobId) return;
    await api.cancelJob(jobId).catch(() => {});
    // Job result arrives async → phase flips to "cancelled" via awaitJob.
  };

  const fieldCls =
    "h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground";
  const labelCls = "flex flex-col gap-0.5 text-[10px] text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={(o) => phase !== "running" && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Rocket className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base">{t("exportDlg.title")}</DialogTitle>
              <DialogDescription>
                {version ? version.name : t("versions.master")} · {canvas.width}×{canvas.height}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase === "config" && (
          <div className="space-y-4">
            {/* Format summary — real data only */}
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-1 p-3">
              <AspectTile w={canvas.width} h={canvas.height} />
              <div className="text-xs">
                <div className="font-medium">
                  {ratioStr} · {canvas.width}×{canvas.height} ·{" "}
                  {(canvas.fpsNum / canvas.fpsDen).toFixed(canvas.fpsDen === 1 ? 0 : 2)} fps
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}
                  {doc.subtitles.length > 0 &&
                    ` · ${t("exportDlg.captions", { count: doc.subtitles.length })}`}
                </div>
              </div>
            </div>

            {/* Friendly presets */}
            <div>
              <p className="mb-1.5 text-xs font-medium">{t("exportDlg.presets")}</p>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((p) => {
                  const Icon = p.icon;
                  const active = presetKey === p.key;
                  return (
                    <button
                      key={p.key}
                      onClick={() => pickPreset(p)}
                      className={cn(
                        "rounded-xl border-2 p-2.5 text-left transition-all",
                        active
                          ? "border-primary bg-primary/10 shadow-raise"
                          : "border-border hover:border-muted-foreground/50 hover:bg-accent/40",
                      )}
                    >
                      <Icon className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} />
                      <div className="mt-1 text-xs font-medium">{t(`exportDlg.preset_${p.key}`)}</div>
                      <div className="text-[10px] leading-tight text-muted-foreground">
                        {t(`exportDlg.preset_${p.key}_hint`)}
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                {cfg.codec} · {cfg.preset} · CRF {cfg.crf}
                {cfg.videoBitrate ? ` · ${cfg.videoBitrate}` : ""} · {cfg.audioCodec}{" "}
                {cfg.audioBitrate}
              </p>
            </div>

            {/* Container */}
            <div>
              <p className="mb-1.5 text-xs font-medium">{t("exportDlg.format")}</p>
              <div className="flex gap-1 rounded-lg bg-surface-1 p-1">
                {EXPORT_MATRIX.containers.map((c) => (
                  <button
                    key={c}
                    onClick={() => pickContainer(c)}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium uppercase transition-colors",
                      cfg.container === c
                        ? "bg-primary text-primary-foreground shadow-raise"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Advanced */}
            <div className="rounded-xl border border-border">
              <button
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setAdvanced(!advanced)}
              >
                {t("exportDlg.advanced")}
                <ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} />
              </button>
              {advanced && (
                <div className="grid grid-cols-3 gap-2 border-t border-border/60 px-3 py-3">
                  <label className={labelCls}>
                    {t("exportDlg.videoCodec")}
                    <select className={fieldCls} value={cfg.codec} onChange={(e) => patch({ codec: e.target.value })}>
                      {EXPORT_MATRIX.videoCodecs.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className={labelCls}>
                    {t("exportDlg.speed")}
                    <select className={fieldCls} value={cfg.preset} onChange={(e) => patch({ preset: e.target.value })}>
                      {EXPORT_MATRIX.presets.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className={labelCls} title={t("exportDlg.crfHint")}>
                    {t("exportDlg.qualityCrf")}
                    <input
                      type="number" min={0} max={51} className={fieldCls}
                      value={cfg.crf}
                      onChange={(e) => patch({ crf: Math.min(51, Math.max(0, +e.target.value)) })}
                    />
                  </label>
                  <label className={labelCls}>
                    {t("exportDlg.bitrate")}
                    <input
                      className={fieldCls} placeholder={t("versions.bitratePh")}
                      value={cfg.videoBitrate ?? ""}
                      onChange={(e) => patch({ videoBitrate: e.target.value || null })}
                    />
                  </label>
                  <label className={labelCls}>
                    {t("exportDlg.audioCodec")}
                    <select className={fieldCls} value={cfg.audioCodec} onChange={(e) => patch({ audioCodec: e.target.value })}>
                      {EXPORT_MATRIX.audioCodecs.map((c) => <option key={c} value={c}>{c === "none" ? "none (mute)" : c}</option>)}
                    </select>
                  </label>
                  <label className={labelCls}>
                    {t("exportDlg.audioRate")}
                    <select
                      className={fieldCls} value={cfg.audioBitrate}
                      onChange={(e) => patch({ audioBitrate: e.target.value })}
                    >
                      {["96k", "128k", "192k", "256k", "320k"].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>

            {err && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {err}
              </p>
            )}
            {secs <= 0 && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                {t("exportDlg.emptyTimeline")}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void start()} disabled={!!err || !filePath || secs <= 0}>
                <FileVideo className="mr-1 size-4" /> {t("exportDlg.chooseDest")}
              </Button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <Loader2 className="size-5 animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t("exportDlg.exporting")}</p>
                <p className="truncate text-[11px] text-muted-foreground">{outPath}</p>
              </div>
              <span className="font-mono text-sm">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => void cancel()}>
                <XCircle className="mr-1 size-4" /> {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-6 text-emerald-400" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("exportDlg.doneTitle")}</p>
                <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{outPath}</p>
                {skipped > 0 && (
                  <p className="mt-1 text-[11px] text-warning">
                    {t("exportDlg.skipped", { count: skipped })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => outPath && void api.revealPath(outPath)}
              >
                <FolderOpen className="mr-1 size-4" /> {t("exportDlg.showInFolder")}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t("common.done")}</Button>
            </div>
          </div>
        )}

        {phase === "cancelled" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 size-6 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t("exportDlg.cancelledTitle")}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("exportDlg.cancelledBody")}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
              <Button onClick={() => setPhase("config")}>{t("exportDlg.tryAgain")}</Button>
            </div>
          </div>
        )}

        {phase === "failed" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 size-6 text-destructive" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("exportDlg.failedTitle")}</p>
                <p className="mt-1 max-h-24 overflow-y-auto break-all rounded bg-destructive/10 p-2 font-mono text-[11px] text-destructive/90">
                  {error}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
              <Button onClick={() => setPhase("config")}>{t("exportDlg.tryAgain")}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
