import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Download,
  Scissors,
  Type,
  Music4,
  Subtitles,
  ImageIcon,
  Pause,
  Play,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { useProject } from "@/stores/project";
import { SuggestionBanner } from "@/components/SuggestionBanner";
import { EmptyState } from "@/components/EmptyState";
import { Clapperboard } from "lucide-react";
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
import { ExportDialog } from "./ExportDialog";

/**
 * Phase-3 vertical slice editor: media bin → preview → timeline → export.
 * All edits flow through useEditor.mutate → project store → autosave.
 */
export function EditorPage() {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
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

  const [exportOpen, setExportOpen] = useState(false);
  // Deep-link params: /editor?tab=subtitles, /editor?left=graphics
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [bottomTab, setBottomTab] = useState<"timeline" | "subtitles">(
    params.get("tab") === "subtitles" ? "subtitles" : "timeline",
  );
  const [leftTab, setLeftTab] = useState<"media" | "graphics">(
    params.get("left") === "graphics" ? "graphics" : "media",
  );

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

  const compareMode = useEditor((s) => s.compareMode);
  const activeVersionId = useEditor((s) => s.activeVersionId);
  const comparePane = compareMode && activeVersionId !== null;

  if (!doc) {
    return (
      <EmptyState
        icon={Clapperboard}
        title="Nothing open yet"
        body="Start a new project or pick a recent one from Home — your timeline, captions and formats live here."
        action={{ label: "New project", onClick: () => nav("/create") }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SuggestionBanner doc={doc} />
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5">
        <span className="text-sm font-medium">
          {doc.meta.name}
          {dirty && <span className="ml-1 text-warning">•</span>}
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
        <div className="mx-1 h-4 w-px bg-border" />
        {/* Common actions — labeled, each routes to the existing workflow. */}
        <button
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Split selected clip at playhead (S)"
          onClick={() => {
            const es = useEditor.getState();
            for (const id of es.selection) {
              mutate((d) => { const r = splitClip(d, id, es.playheadMs); return r ? r.doc : d; });
            }
          }}
        >
          <Scissors className="size-3.5" /> Trim
        </button>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Add text — Graphics bin"
          onClick={() => setLeftTab("graphics")}
        >
          <Type className="size-3.5" /> Text
        </button>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Add music — Media bin"
          onClick={() => setLeftTab("media")}
        >
          <Music4 className="size-3.5" /> Music
        </button>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Captions — Subtitle Studio"
          onClick={() => setBottomTab("subtitles")}
        >
          <Subtitles className="size-3.5" /> Captions
        </button>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Overlay graphics — Graphics bin"
          onClick={() => setLeftTab("graphics")}
        >
          <ImageIcon className="size-3.5" /> Overlay
        </button>
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
        <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}>
          <Download className="mr-1 size-4" /> {t("editor.export")}
        </Button>
      </div>

      {/* Middle: bin + preview */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-56 shrink-0 flex-col">
          <div className="flex gap-1 border-b border-r border-border px-1.5 py-1">
            {([["media", Music4], ["graphics", ImageIcon]] as const).map(([tb, Icon]) => (
              <button
                key={tb}
                onClick={() => setLeftTab(tb)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
                  leftTab === tb ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" /> {tb}
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
              <span className="absolute left-2 top-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-accent-foreground">
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
        <div className="flex gap-1 border-b border-border px-2 py-1">
          {([["timeline", Scissors, "Timeline"], ["subtitles", Subtitles, "Subtitles"]] as const).map(([tab, Icon, label]) => (
            <button
              key={tab}
              onClick={() => setBottomTab(tab)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
                bottomTab === tab ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" /> {label}
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

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}
