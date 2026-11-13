import { useTranslation } from "react-i18next";
import { useState } from "react";
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
import {
  addVersion,
  duplicateVersion,
  getVersion,
  removeVersion,
  renameVersion,
  resetVersion,
  setVersionClipOverride,
} from "@/lib/timeline-engine";
import type { AssetSummary } from "@/lib/media-types";
import type { FormatVersion, Keyframe } from "@/lib/project-types";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-t border-border bg-card/60 px-3 py-1.5">
      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
      {/* Master */}
      <button
        className={`shrink-0 rounded border px-2 py-1 text-[10px] ${
          activeId === null
            ? "border-primary bg-primary/15 text-foreground"
            : "border-border text-muted-foreground hover:bg-accent"
        }`}
        onClick={() => setActive(null)}
      >
        {t("versions.master")} · {doc.canvas.width}×{doc.canvas.height}
      </button>

      {versions.map((v) => (
        <div
          key={v.id}
          className={`group flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] ${
            activeId === v.id
              ? "border-primary bg-primary/15 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent"
          }`}
        >
          <button className="text-left" onClick={() => setActive(v.id)}>
            <div>{v.name}</div>
            <div className="text-[9px] opacity-60">
              {v.canvas.width}×{v.canvas.height}
            </div>
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
              onClick={() => {
                const name = window.prompt(t("versions.renamePrompt"), v.name);
                if (name) mutate((d) => renameVersion(d, v.id, name));
              }}
              className="rounded px-0.5 text-[9px] hover:text-foreground"
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

      {/* Add from preset */}
      <select
        className="shrink-0 rounded border border-border bg-background px-1.5 py-1 text-[10px]"
        value=""
        onChange={(e) => e.target.value && createFrom(e.target.value)}
      >
        <option value="">+ {t("versions.addFormat")}</option>
        {FORMAT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <div className="mx-1 h-4 w-px shrink-0 bg-border" />
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
  );
}
