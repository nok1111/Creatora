import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import {
  Copy,
  FolderDown,
  Layers,
  RotateCcw,
  ScanSearch,
  SplitSquareHorizontal,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";
import { FORMAT_PRESETS, defaultReframe, presetById } from "@/lib/format-presets";
import { EXPORT_MATRIX, validateExportSettings } from "@/lib/project-types";
import {
  addVersion,
  duplicateVersion,
  getVersion,
  removeVersion,
  renameVersion,
  resetVersion,
  setVersionClipOverride,
} from "@/lib/timeline-engine";
import type { ExportSettings } from "@/lib/project-types";
import type { AssetSummary } from "@/lib/media-types";
import type { FormatVersion, Keyframe } from "@/lib/project-types";
import { Button } from "@/components/ui/button";
import { AnchoredMenu } from "@/components/ui/anchored-menu";
import { PromptDialog } from "@/components/PromptDialog";

interface MotionSample {
  tMs: number;
  cx: number;
  cy: number;
  energy: number;
  motion: boolean;
}

/**
 * Multi-format versions strip — create/switch/compare/edit/export versions.
 * Structural timeline ops stay shared; only whitelisted clip fields diverge
 * per version (ADR-021). Versions ride the same undo history via `mutate`.
 */
export function VersionsPanel({ assets }: { assets: Map<string, AssetSummary> }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const filePath = useProject((s) => s.filePath);
  const save = useProject((s) => s.save);
  const mutate = useEditor((s) => s.mutate);
  const activeId = useEditor((s) => s.activeVersionId);
  const setActive = useEditor((s) => s.setActiveVersion);
  const compare = useEditor((s) => s.compareMode);
  const setCompare = useEditor((s) => s.setCompareMode);
  const [reframing, setReframing] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);
  const [showExportCfg, setShowExportCfg] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  if (!doc) return null;
  const versions = doc.versions;

  const createFrom = (presetId: string) => {
    const p = presetById(presetId);
    if (!p) return;
    const { doc: next, versionId } = addVersion(doc, {
      name: p.label,
      presetId: p.id,
      canvas: {
        width: p.canvas.width,
        height: p.canvas.height,
        fpsNum: doc.canvas.fpsNum,
        fpsDen: doc.canvas.fpsDen,
        background: doc.canvas.background,
      },
      safeZones: p.safeZones,
    });
    // Seed a cover-fit reframe for every visual clip — sane default the
    // user (or auto-reframe) then refines.
    let d = next;
    for (const track of next.timeline.tracks) {
      for (const clip of track.clips) {
        if (!clip.mediaRef) continue;
        const a = assets.get(clip.mediaRef);
        if (!a?.width || !a?.height) continue;
        const r = defaultReframe(a.width, a.height, p.canvas.width, p.canvas.height);
        d = setVersionClipOverride(d, versionId, clip.id, {
          transform: { ...clip.transform, x: r.x, y: r.y, scaleX: r.scale, scaleY: r.scale },
        });
      }
    }
    mutate(() => d);
    setActive(versionId);
  };

  /** Auto-reframe every visual clip in the active version via local motion
   * analysis → transform.x/y keyframes (manual edits remain possible). */
  const autoReframe = async (v: FormatVersion) => {
    if (reframing) return;
    setReframing(v.id);
    let d = useProject.getState().doc!;
    let tracked = 0;
    try {
      for (const track of d.timeline.tracks) {
        for (const clip of track.clips) {
          if (!clip.mediaRef) continue;
          const a = assets.get(clip.mediaRef);
          if (!a?.width || !a?.height || a.kind !== "video") continue;
          const dur = (clip.sourceDurationMs ?? a.durationMs ?? clip.durationMs) as number;
          const jobId = await api.analyzeSubject(
            a.filePath,
            clip.sourceInMs,
            Math.min(dur, clip.sourceInMs + clip.durationMs),
            24,
          );
          const fin = await awaitJob<MotionSample[]>(jobId);
          if (fin.status !== "done" || !fin.result) continue;
          const samples = fin.result;
          const kx: Keyframe[] = [];
          const ky: Keyframe[] = [];
          for (const s of samples) {
            const r = defaultReframe(a.width, a.height, v.canvas.width, v.canvas.height, s.cx, s.cy);
            kx.push({ tMs: s.tMs, v: r.x, ease: "linear" });
            ky.push({ tMs: s.tMs, v: r.y, ease: "linear" });
          }
          const r0 = defaultReframe(a.width, a.height, v.canvas.width, v.canvas.height);
          d = setVersionClipOverride(d, v.id, clip.id, {
            transform: { ...clip.transform, x: r0.x, y: r0.y, scaleX: r0.scale, scaleY: r0.scale },
            keyframes: { "transform.x": kx, "transform.y": ky },
          });
          if (samples.some((s) => s.motion)) tracked++;
        }
      }
      mutate(() => d);
      toast.success(t("versions.reframeDone"), {
        description:
          tracked > 0
            ? t("versions.reframeTracked", { count: tracked })
            : t("versions.reframeStatic"),
      });
    } catch (e) {
      toast.error(t("versions.reframeFailed"), { description: String(e) });
    } finally {
      setReframing(null);
    }
  };

  /** Export master + all versions — one job each, failures independent. */
  const batchExport = async () => {
    if (!filePath || batching) return;
    setBatching(true);
    try {
      await save();
      const dir = await openDialog({ directory: true, title: t("versions.pickDir") });
      if (!dir || typeof dir !== "string") return;
      const jobIds = await api.exportVersions(
        filePath,
        dir,
        versions.map((v) => v.id),
      );
      let ok = 0;
      let failed = 0;
      await Promise.all(
        jobIds.map(async (id) => {
          const fin = await awaitJob<{ outputPath: string }>(id);
          if (fin.status === "done") ok++;
          else failed++;
        }),
      );
      if (failed === 0) toast.success(t("versions.batchDone"), { description: dir });
      else toast.error(t("versions.batchPartial"), { description: `${ok} ok, ${failed} failed` });
    } catch (e) {
      toast.error(t("editor.exportFailed"), { description: String(e) });
    } finally {
      setBatching(false);
    }
  };

  const active = activeId ? getVersion(doc, activeId) : undefined;

  /** Small block showing the real aspect ratio — recognisable at a glance. */
  const aspectTile = (w: number, h: number, activeChip: boolean) => {
    const portrait = h > w;
    const bw = portrait ? 8 : 14;
    const bh = portrait ? 14 : Math.max(7, Math.round((14 * h) / w));
    return (
      <span
        className={`inline-block shrink-0 rounded-[2px] border ${
          activeChip ? "border-primary bg-primary/40" : "border-muted-foreground/50 bg-muted-foreground/20"
        }`}
        style={{ width: bw, height: bh }}
      />
    );
  };

  const ratioStr = (w: number, h: number) => {
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const d = g(w, h);
    return `${w / d}:${h / d}`;
  };

  const patchExport = (v: FormatVersion, patch: Partial<ExportSettings>) => {
    mutate((d) => {
      const n = structuredClone(d);
      const vv = n.versions.find((x) => x.id === v.id);
      if (vv) vv.export = { ...vv.export, ...patch };
      return n;
    });
  };

  const exportError = active ? validateExportSettings(active.export) : null;

  return (
    <div className="border-t border-border bg-card/60">
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-1.5">
      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
      {/* Master */}
      <button
        className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors ${
          activeId === null
            ? "border-primary bg-primary/15 text-foreground shadow-raise"
            : "border-border text-muted-foreground hover:bg-accent"
        }`}
        onClick={() => setActive(null)}
      >
        {aspectTile(doc.canvas.width, doc.canvas.height, activeId === null)}
        <span className="text-left">
          <div>{t("versions.master")}</div>
          <div className="text-[10px] opacity-60">
            {ratioStr(doc.canvas.width, doc.canvas.height)} · {doc.canvas.width}×{doc.canvas.height}
          </div>
        </span>
      </button>

      {versions.map((v) => (
        <div
          key={v.id}
          className={`group flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors ${
            activeId === v.id
              ? "border-primary bg-primary/15 text-foreground shadow-raise"
              : "border-border text-muted-foreground hover:bg-accent"
          }`}
        >
          <button className="flex items-center gap-1.5 text-left" onClick={() => setActive(v.id)}>
            {aspectTile(v.canvas.width, v.canvas.height, activeId === v.id)}
            <span>
              <div>{v.name}</div>
              <div className="text-[10px] opacity-60">
                {ratioStr(v.canvas.width, v.canvas.height)} · {v.canvas.width}×{v.canvas.height}
              </div>
            </span>
          </button>
          <div className="ml-1 hidden items-center gap-0.5 group-hover:flex">
            <button
              title={t("versions.autoReframe")}
              disabled={reframing === v.id}
              onClick={() => void autoReframe(v)}
              className="rounded p-0.5 hover:text-foreground disabled:opacity-40"
            >
              <ScanSearch className="size-3" />
            </button>
            <button
              title={t("versions.duplicate")}
              onClick={() => {
                const { doc: d2, versionId } = duplicateVersion(doc, v.id);
                mutate(() => d2);
                if (versionId) setActive(versionId);
              }}
              className="rounded p-0.5 hover:text-foreground"
            >
              <Copy className="size-3" />
            </button>
            <button
              title={t("versions.reset")}
              onClick={() => mutate((d) => resetVersion(d, v.id))}
              className="rounded p-0.5 hover:text-foreground"
            >
              <RotateCcw className="size-3" />
            </button>
            <button
              title={t("versions.rename")}
              onClick={() => setRenaming({ id: v.id, name: v.name })}
              className="rounded px-0.5 text-[10px] hover:text-foreground"
            >
              Aa
            </button>
            <button
              title={t("versions.delete")}
              onClick={() => {
                mutate((d) => removeVersion(d, v.id));
                if (activeId === v.id) setActive(null);
              }}
              className="rounded p-0.5 hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        </div>
      ))}

      {/* Add from preset — visual aspect-ratio cards (Phase 10.5B). Menu is
          portalled (AnchoredMenu): the strip's overflow-x-auto would clip an
          absolute popover regardless of z-index. */}
      <div className="relative shrink-0">
        <button
          ref={addBtnRef}
          className="rounded border border-border bg-background px-1.5 py-1 text-[10px] hover:bg-accent"
          onClick={() => setShowAdd(!showAdd)}
        >
          + {t("versions.addFormat")}
        </button>
        <AnchoredMenu
          open={showAdd}
          onClose={() => setShowAdd(false)}
          anchor={addBtnRef}
          side="top"
          align="start"
          className="flex w-[420px] flex-wrap gap-2 rounded-xl bg-card p-3 shadow-xl"
        >
              {FORMAT_PRESETS.map((p) => {
                const portrait = p.canvas.height > p.canvas.width;
                const bw = portrait ? 26 : 44;
                const bh = portrait ? 44 : Math.max(20, Math.round((44 * p.canvas.height) / p.canvas.width));
                const ar = `${p.canvas.width}×${p.canvas.height}`;
                return (
                  <button
                    key={p.id}
                    onClick={() => { createFrom(p.id); setShowAdd(false); }}
                    className="flex w-[96px] flex-col items-center gap-1.5 rounded-lg border-2 border-border p-2 transition-all hover:border-accent hover:bg-accent/10"
                    title={p.label}
                  >
                    <div
                      className="flex items-center justify-center rounded border border-border bg-secondary text-[8px] font-medium text-muted-foreground"
                      style={{ width: bw, height: bh }}
                    >
                      {ratioStr(p.canvas.width, p.canvas.height)}
                    </div>
                    <div className="text-center text-[10px] font-medium leading-tight">
                      {p.platform}
                      <div className="text-[8px] font-normal text-muted-foreground">{ar}</div>
                      {p.maxDurationMs && (
                        <div className="text-[8px] text-warning">≤{Math.round(p.maxDurationMs / 1000)}s</div>
                      )}
                    </div>
                  </button>
                );
              })}
        </AnchoredMenu>
      </div>

      <div className="mx-1 h-4 w-px shrink-0 bg-border" />
      {active && (
        <button
          className={`flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] ${
            showExportCfg ? "border-primary text-foreground" : "border-border text-muted-foreground"
          }`}
          title={t("versions.exportSettings")}
          onClick={() => setShowExportCfg(!showExportCfg)}
        >
          ⚙ {active.export.codec} · CRF {active.export.crf} · {active.export.container}
        </button>
      )}
      {active && (
        <button
          className={`flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] ${
            compare ? "border-primary text-foreground" : "border-border text-muted-foreground"
          }`}
          title={t("versions.compareHint")}
          onClick={() => setCompare(!compare)}
        >
          <SplitSquareHorizontal className="size-3" /> {t("versions.compare")}
        </button>
      )}
      {versions.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          className="h-6 shrink-0 px-2 text-[10px]"
          disabled={batching}
          onClick={() => void batchExport()}
        >
          <FolderDown className="mr-1 size-3" />
          {batching ? t("versions.batching") : t("versions.exportAll")}
        </Button>
      )}
    </div>

    {/* Effective export settings for the active version — always shown
        before export (no silently-ignored fields). */}
    {active && showExportCfg && (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-3 py-2 text-[10px]">
        <span className="font-medium">{t("versions.exportFor", { name: active.name })}</span>
        <label className="flex items-center gap-1 text-muted-foreground">
          {t("versions.exportVideo")}
          <select className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground" value={active.export.codec}
            onChange={(e) => patchExport(active, { codec: e.target.value })}>
            {EXPORT_MATRIX.videoCodecs.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground" title={t("versions.exportSpeedTitle")}>
          {t("versions.exportSpeed")}
          <select className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground" value={active.export.preset}
            onChange={(e) => patchExport(active, { preset: e.target.value })}>
            {EXPORT_MATRIX.presets.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground" title={t("versions.exportQualityTitle")}>
          {t("versions.exportQuality")}
          <input type="number" min={0} max={51} className="w-12 rounded-md border border-border bg-background px-1.5 py-1 text-foreground"
            value={active.export.crf}
            onChange={(e) => patchExport(active, { crf: Math.min(51, Math.max(0, Number(e.target.value))) })} />
        </label>
        <label className="flex items-center gap-1 text-muted-foreground" title={t("versions.exportBitrateTitle")}>
          {t("versions.exportBitrate")}
          <input placeholder={t("versions.bitratePh")} className="w-14 rounded-md border border-border bg-background px-1.5 py-1 text-foreground"
            value={active.export.videoBitrate ?? ""}
            onChange={(e) => patchExport(active, { videoBitrate: e.target.value || null })} />
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          {t("versions.exportAudio")}
          <select className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground" value={active.export.audioCodec}
            onChange={(e) => patchExport(active, { audioCodec: e.target.value })}>
            {EXPORT_MATRIX.audioCodecs.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground" value={active.export.audioBitrate}
            onChange={(e) => patchExport(active, { audioBitrate: e.target.value })}>
            {["96k", "128k", "192k", "256k", "320k"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          {t("versions.exportFormat")}
          <select className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground" value={active.export.container}
            onChange={(e) => patchExport(active, { container: e.target.value })}>
            {EXPORT_MATRIX.containers.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <span className="text-muted-foreground">
          {active.canvas.width}×{active.canvas.height} · {active.canvas.fpsNum}/{active.canvas.fpsDen}fps
        </span>
        {exportError && <span className="text-destructive">{exportError}</span>}
      </div>
    )}

    <PromptDialog
      open={!!renaming}
      title={t("versions.rename")}
      defaultValue={renaming?.name}
      onSubmit={(name) => {
        if (name.trim() && renaming) mutate((d) => renameVersion(d, renaming.id, name.trim()));
      }}
      onClose={() => setRenaming(null)}
    />
    </div>
  );
}
