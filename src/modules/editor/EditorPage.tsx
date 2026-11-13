import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Download,
  Pause,
  Play,
  Redo2,
  Save,
  Undo2,
  AlertCircle,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/ipc";
import { awaitJob, onJobProgress } from "@/services/jobs";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import {
  splitClip,
  removeClips,
  extractClips,
  pasteClips,
  duplicateClips,
  frameToMs,
  timelineDuration,
} from "@/lib/timeline-engine";
import type { AssetSummary } from "@/lib/media-types";
import { Button } from "@/components/ui/button";
import { Preview } from "./Preview";
import { VersionsPanel } from "./VersionsPanel";
import { TimelinePanel } from "./TimelinePanel";
import { SubtitlesPanel } from "./SubtitlesPanel";
import { MediaBin } from "./MediaBin";
import { GraphicsBin } from "./GraphicsBin";
import { Inspector } from "./Inspector";

/**
 * Phase-3 vertical slice editor: media bin → preview → timeline → export.
 * All edits flow through useEditor.mutate → project store → autosave.
 */
export function EditorPage() {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const filePath = useProject((s) => s.filePath);
  const dirty = useProject((s) => s.dirty);
  const save = useProject((s) => s.save);

  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const select = useEditor((s) => s.select);
  const mutate = useEditor((s) => s.mutate);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const previewQuality = useEditor((s) => s.previewQuality);
  const setPreviewQuality = useEditor((s) => s.setPreviewQuality);

  const [exporting, setExporting] = useState<{ jobId: string; progress: number } | null>(null);
  const [bottomTab, setBottomTab] = useState<"timeline" | "subtitles">("timeline");
  const [leftTab, setLeftTab] = useState<"media" | "graphics">("media");

  const assetsQ = useQuery({
    queryKey: ["assets"],
    queryFn: () => api.listAssets(),
    refetchInterval: 30_000,
  });
  const assetMap = useMemo(
    () => new Map<string, AssetSummary>((assetsQ.data ?? []).map((a) => [a.id, a])),
    [assetsQ.data],
  );

  // --- keyboard shortcuts ---
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      const meta = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const es = useEditor.getState();
      const currentDoc = useProject.getState().doc;
      if (!currentDoc) return;

      if (meta && key === "s" && !e.shiftKey) {
        e.preventDefault();
        void save().then(() => toast.success(t("editor.saved")));
      } else if (meta && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((meta && key === "y") || (meta && e.shiftKey && key === "z")) {
        e.preventDefault();
        redo();
      } else if (meta && key === "c") {
        if (es.selection.length) {
          es.setClipboard(extractClips(currentDoc, es.selection));
          toast.success(t("editor.copied", { count: es.selection.length }));
        }
      } else if (meta && key === "x") {
        if (es.selection.length) {
          es.setClipboard(extractClips(currentDoc, es.selection));
          mutate((d) => removeClips(d, es.selection).doc);
          select([]);
        }
      } else if (meta && key === "v") {
        if (es.clipboard.length) {
          let ids: string[] = [];
          mutate((d) => {
            const r = pasteClips(d, es.clipboard, es.playheadMs);
            ids = r.clipIds;
            return r.doc;
          });
          select(ids);
        }
      } else if (meta && key === "d") {
        e.preventDefault();
        if (es.selection.length) {
          let ids: string[] = [];
          mutate((d) => {
            const r = duplicateClips(d, es.selection);
            ids = r.clipIds;
            return r.doc;
          });
          select(ids);
        }
      } else if (meta && key === "a") {
        e.preventDefault();
        select(currentDoc.timeline.tracks.flatMap((tr) => tr.clips.map((c) => c.id)));
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying(!es.playing);
      } else if (key === "s" && !meta) {
        for (const id of es.selection) {
          mutate((d) => {
            const r = splitClip(d, id, es.playheadMs);
            return r ? r.doc : d;
          });
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (es.selection.length) {
          mutate((d) => removeClips(d, es.selection).doc);
          select([]);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const step = frameToMs(e.shiftKey ? 10 : 1, currentDoc);
        setPlayhead(es.playheadMs + (e.key === "ArrowRight" ? step : -step));
      } else if (e.key === "Home") {
        setPlayhead(0);
      } else if (e.key === "End") {
        setPlayhead(timelineDuration(currentDoc));
      }
    },
    [save, t, undo, redo, setPlaying, mutate, select, setPlayhead],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  // --- export ---
  const exportNow = async () => {
    if (!filePath || exporting) return;
    const out = await saveDialog({
      title: t("editor.exportTitle"),
      defaultPath: `${doc?.meta.name ?? "export"}.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!out) return;
    try {
      await save(); // render the saved file — export == persisted state
      const jobId = await api.exportProject(filePath, out, useEditor.getState().activeVersionId ?? undefined);
      setExporting({ jobId, progress: 0 });
      const off = onJobProgress((p) => {
        if (p.jobId === jobId) setExporting({ jobId, progress: p.progress });
      });
      const fin = await awaitJob<{ outputPath: string; skippedClips: number }>(jobId);
      off();
      setExporting(null);
      if (fin.status === "done") {
        toast.success(t("editor.exportDone"), { description: fin.result?.outputPath });
      } else {
        toast.error(t("editor.exportFailed"), { description: fin.error });
      }
    } catch (e) {
      setExporting(null);
      toast.error(t("editor.exportFailed"), { description: String(e) });
    }
  };

  const compareMode = useEditor((s) => s.compareMode);
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const comparePane = compareMode && activeVersionId !== null;

  if (!doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <AlertCircle className="size-8" />
        <p className="text-sm">{t("editor.noProject")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
        <span className="text-sm font-medium">
          {doc.meta.name}
          {dirty && <span className="ml-1 text-amber-400">•</span>}
        </span>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon" className="size-7" onClick={() => void save()} title="Ctrl+S">
          <Save className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" disabled={!canUndo} onClick={undo} title="Ctrl+Z">
          <Undo2 className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" disabled={!canRedo} onClick={redo} title="Ctrl+Y">
          <Redo2 className="size-4" />
        </Button>
        <div className="flex-1" />
        <button
          className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
          title={t("editor.qualityHint")}
          onClick={() =>
            setPreviewQuality(previewQuality === "proxy" ? "full" : "proxy")
          }
        >
          {previewQuality === "proxy" ? t("editor.qualityProxy") : t("editor.qualityFull")}
        </button>
        {exporting ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-1.5 w-36 overflow-hidden rounded bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.max(2, exporting.progress * 100)}%` }}
              />
            </div>
            {Math.round(exporting.progress * 100)}%
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void exportNow()}>
            <Download className="mr-1 size-4" /> {t("editor.export")}
          </Button>
        )}
      </div>

      {/* Middle: bin + preview */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 shrink-0 flex-col">
          <div className="flex gap-1 border-b border-r border-border px-1.5 py-0.5">
            {(["media", "graphics"] as const).map((tb) => (
              <button
                key={tb}
                onClick={() => setLeftTab(tb)}
                className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  leftTab === tb ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tb}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {leftTab === "media" ? <MediaBin assets={assetsQ.data ?? []} /> : <GraphicsBin />}
          </div>
        </div>
        <div className="relative flex min-w-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <Preview assets={assetMap} />
          </div>
          {comparePane && (
            <div className="relative min-w-0 flex-1 border-l border-border">
              <span className="absolute left-2 top-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-cyan-300">
                {doc?.meta.name} · master
              </span>
              <Preview assets={assetMap} docOverride={doc ?? undefined} />
            </div>
          )}
          {/* Transport overlay */}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/90 px-3 py-1 backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              onClick={() => setPlaying(!playing)}
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
          </div>
        </div>
        <div className="w-64 shrink-0">
          <Inspector />
        </div>
      </div>

      {/* Multi-format versions */}
      <VersionsPanel assets={assetMap} />

      {/* Timeline / Subtitle Studio */}
      <div className="flex h-64 shrink-0 flex-col border-t border-border">
        <div className="flex gap-1 border-b border-border px-2 py-0.5">
          {(["timeline", "subtitles"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setBottomTab(tab)}
              className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                bottomTab === tab ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "timeline" ? "Timeline" : "Subtitles"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {bottomTab === "timeline" ? (
            <TimelinePanel assets={assetMap} />
          ) : (
            <SubtitlesPanel assets={assetMap} />
          )}
        </div>
      </div>
    </div>
  );
}
