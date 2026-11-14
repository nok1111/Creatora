import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Music, Film, Image as ImageIcon, Plus, AlertTriangle, Zap, FolderInput, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";
import { useProject } from "@/stores/project";
import { useEditor } from "@/stores/editor";
import { addClip } from "@/lib/timeline-engine";
import type { AssetSummary } from "@/lib/media-types";
import { EmptyState } from "@/components/EmptyState";
import { reportError } from "@/lib/errors";

/** Project media bin: imported assets → click + or drag onto a track. */
export function MediaBin({ assets }: { assets: AssetSummary[] }) {
  const { t } = useTranslation();
  const doc = useProject((s) => s.doc);
  const playheadMs = useEditor((s) => s.playheadMs);
  const mutate = useEditor((s) => s.mutate);
  const select = useEditor((s) => s.select);
  const qc = useQueryClient();

  if (!doc) return null;

  const usable = assets.filter((a) =>
    ["video", "audio", "image"].includes(a.kind),
  );

  const addAt = (a: AssetSummary) => {
    const trackKind = a.kind === "audio" ? "audio" : "video";
    const dur = a.durationMs ?? 3000;
    let clipId = "";
    mutate((d) => {
      const r = addClip(d, {
        mediaRef: a.id,
        startMs: playheadMs,
        durationMs: dur,
        sourceDurationMs: a.durationMs ?? null,
        trackKind,
      });
      clipId = r.clipId;
      // Register the media ref so save/export resolves it.
      if (!r.doc.mediaRefs.some((m) => m.assetId === a.id)) {
        r.doc.mediaRefs.push({ assetId: a.id, path: a.filePath, hash: null });
      }
      return r.doc;
    });
    select([clipId]);
    toast.success(t("editor.clipAdded"));
  };

  const importFiles = async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Media", extensions: ["mp4","mov","mkv","avi","webm","m4v","mp3","wav","aac","m4a","flac","ogg","png","jpg","jpeg","webp","gif","bmp","tiff"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length) return;
    const jobId = await api.importMedia(paths);
    await awaitJob(jobId);
    await qc.invalidateQueries({ queryKey: ["assets"] });
  };

  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        {t("editor.mediaBin")}
        <button
          className="rounded p-1 hover:bg-accent"
          title="Import media"
          onClick={() => void importFiles()}
        >
          <FolderInput className="size-3.5" />
        </button>
        {usable.some((a) => a.kind === "video" && !a.proxyPath) && (
          <button
            className="rounded p-1 hover:bg-accent"
            title={t("editor.genProxies")}
            onClick={async () => {
              const ids = usable
                .filter((a) => a.kind === "video" && !a.proxyPath)
                .map((a) => a.id);
              const jobId = await api.generateProxies(ids);
              await awaitJob(jobId);
              await qc.invalidateQueries({ queryKey: ["assets"] });
              toast.success(t("editor.proxiesDone"));
            }}
          >
            <Zap className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {usable.map((a) => (
          <div
            key={a.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-creatora-asset", a.id);
              e.dataTransfer.setData("application/x-creatora-path", a.filePath);
              e.dataTransfer.setData(
                "application/x-creatora-duration",
                String(a.durationMs ?? 3000),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
            className="group flex cursor-grab items-center gap-2 rounded border border-border bg-background/60 p-1.5 text-xs hover:bg-accent"
          >
            {a.thumbnailPath ? (
              <img
                src={convertFileSrc(a.thumbnailPath)}
                className="size-9 rounded object-cover"
                alt=""
                draggable={false}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="flex size-9 items-center justify-center rounded bg-secondary">
                {a.kind === "audio" ? (
                  <Music className="size-4 text-muted-foreground" />
                ) : a.kind === "image" ? (
                  <ImageIcon className="size-4 text-muted-foreground" />
                ) : (
                  <Film className="size-4 text-muted-foreground" />
                )}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate">{a.name}</div>
              <div className="text-[10px] text-muted-foreground">
                {a.durationMs ? `${(a.durationMs / 1000).toFixed(1)}s` : a.kind}
                {a.status === "missing" && (
                  <span className="ml-1 text-warning">
                    <AlertTriangle className="inline size-3" /> {t("editor.missingMedia")}
                  </span>
                )}
              </div>
            </div>
            {a.status === "missing" && (
              <button
                onClick={async () => {
                  const sel = await openDialog({
                    title: t("library.relinkTitle", { name: a.name }),
                  });
                  if (typeof sel !== "string") return;
                  try {
                    await api.relinkAsset(a.id, sel);
                    toast.success(t("library.relinked"));
                    void qc.invalidateQueries({ queryKey: ["assets"] });
                  } catch (e) {
                    reportError(e);
                  }
                }}
                className="rounded p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                title={t("library.relink")}
                aria-label={t("library.relink")}
              >
                <Link2 className="size-4" />
              </button>
            )}
            <button
              onClick={() => addAt(a)}
              className="rounded p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
              title={t("editor.addAtPlayhead")}
            >
              <Plus className="size-4" />
            </button>
          </div>
        ))}
        {usable.length === 0 && (
          <EmptyState
            compact
            icon={Film}
            title={t("editor.emptyBin")}
            body="Import videos, audio or images, then drag them onto a track."
            action={{ label: "Import media", onClick: () => void importFiles() }}
          />
        )}
      </div>
    </div>
  );
}
