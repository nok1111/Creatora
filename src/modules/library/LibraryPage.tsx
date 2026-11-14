import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Upload, Search, Film, Music, Image as ImageIcon, FileText,
  AlertTriangle, MoreVertical, Link2, Trash2, Copy, Loader2,
  Star, FolderPlus, Folder, Tag, X, Plus,
} from "lucide-react";
import { api } from "@/lib/ipc";
import type { AssetKind, AssetSummary, ImportOutcome } from "@/lib/media-types";
import { awaitJob, onJobProgress } from "@/services/jobs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

const KIND_FILTERS: (AssetKind | "all")[] = ["all", "video", "audio", "image", "graphic", "font"];

const KIND_ICON: Record<string, typeof Film> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  graphic: ImageIcon,
  font: FileText,
  template: FileText,
  project: FileText,
};

type Filter = { kind: AssetKind | "all"; favorites: boolean; collectionId: string | null; tagId: string | null };

const MEDIA_FILTERS = [
  { name: "Media", extensions: ["mp4","mov","mkv","avi","webm","m4v","mp3","wav","aac","m4a","flac","ogg","png","jpg","jpeg","webp","gif","bmp","tiff"] },
];

function AssetCard({ asset, collections, onRelink, onDelete, onFav, onAssign, onTag }: {
  asset: AssetSummary;
  collections: { id: string; name: string }[];
  onRelink: (a: AssetSummary) => void;
  onDelete: (a: AssetSummary) => void;
  onFav: (a: AssetSummary) => void;
  onAssign: (a: AssetSummary, cid: string) => void;
  onTag: (a: AssetSummary) => void;
}) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[asset.kind] ?? FileText;
  const missing = asset.status === "missing";
  const [thumbError, setThumbError] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [thumbSrc, setThumbSrc] = useState(() =>
    asset.thumbnailPath ? convertFileSrc(asset.thumbnailPath) : null,
  );

  return (
    <div className={cn("group relative overflow-hidden rounded-lg border border-border bg-card", missing && "border-destructive/50")}>
      <div className="relative flex aspect-video items-center justify-center bg-secondary/50">
        {thumbSrc && !missing && !thumbError ? (
          <img
            src={thumbSrc}
            alt={asset.name}
            className="size-full object-cover"
            loading="lazy"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5">
            <Icon className="size-8 text-muted-foreground" />
            {thumbError && (
              <button
                disabled={regenerating}
                className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
                title="Regenerate thumbnail"
                onClick={async () => {
                  setRegenerating(true);
                  try {
                    const p = await api.regenerateThumbnail(asset.id);
                    if (p) {
                      asset.thumbnailPath = p;
                      // Bust the webview's cache of the failed image — same
                      // URL would re-fire onError with the old response.
                      setThumbSrc(`${convertFileSrc(p)}?v=${Date.now()}`);
                      setThumbError(false);
                    } else {
                      toast.error("Couldn't generate a preview for this file");
                    }
                  } catch (e) {
                    toast.error(String(e));
                  } finally {
                    setRegenerating(false);
                  }
                }}
              >
                {regenerating ? <Loader2 className="size-2.5 animate-spin" /> : null}
                {regenerating ? "Working…" : "Regenerate"}
              </button>
            )}
          </div>
        )}
        {missing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60">
            <AlertTriangle className="size-6 text-destructive" />
            <span className="text-2xs font-medium text-destructive">{t("library.missing")}</span>
          </div>
        )}
        <button
          onClick={() => onFav(asset)}
          className={cn(
            "absolute right-1.5 top-1.5 rounded bg-black/50 p-1 opacity-0 transition-opacity group-hover:opacity-100",
            asset.isFavorite && "opacity-100",
          )}
          title={t("library.favorite")}
        >
          <Star className={cn("size-3.5", asset.isFavorite ? "fill-yellow-400 text-yellow-400" : "text-white")} />
        </button>
      </div>
      <div className="flex items-center gap-1 p-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={asset.name}>{asset.name}</p>
          <p className="truncate text-2xs text-muted-foreground">
            {asset.kind}
            {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
            {asset.codec ? ` · ${asset.codec}` : ""}
          </p>
        </div>
        {asset.duplicateOf && (
          <span title={t("library.duplicate")}><Copy className="size-3.5 text-muted-foreground" /></span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary group-hover:opacity-100">
            <MoreVertical className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onRelink(asset)}>
              <Link2 className="size-4" /> {t("library.relink")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTag(asset)}>
              <Tag className="size-4" /> {t("library.addTag")}
            </DropdownMenuItem>
            {collections.length > 0 && <DropdownMenuSeparator />}
            {collections.map((c) => (
              <DropdownMenuItem key={c.id} onClick={() => onAssign(asset, c.id)}>
                <Folder className="size-4" /> {t("library.assignTo", { name: c.name })}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={() => onDelete(asset)}>
              <Trash2 className="size-4" /> {t("library.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function LibraryPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>({ kind: "all", favorites: false, collectionId: null, tagId: null });
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssetSummary | null>(null);
  const [tagTarget, setTagTarget] = useState<AssetSummary | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [newCollection, setNewCollection] = useState("");

  const assets = useQuery({
    queryKey: ["assets", filter, query],
    queryFn: () =>
      api.listAssets({
        kind: filter.kind === "all" ? undefined : filter.kind,
        query: query || undefined,
        favoritesOnly: filter.favorites || undefined,
        collectionId: filter.collectionId ?? undefined,
        tagId: filter.tagId ?? undefined,
      }),
  });
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.listCollections });
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["assets"] });
    qc.invalidateQueries({ queryKey: ["collections"] });
    qc.invalidateQueries({ queryKey: ["tags"] });
  };

  useEffect(() => {
    api.scanMissingAssets().then((n) => { if (n > 0) refresh(); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runImport = async (paths: string[]) => {
    if (!paths.length) return;
    setImporting(true);
    setImportProgress(0);
    try {
      const jobId = await api.importMedia(paths);
      const off = onJobProgress((p) => {
        if (p.jobId === jobId && p.progress >= 0) setImportProgress(p.progress);
      });
      const result = await awaitJob<ImportOutcome>(jobId);
      off();
      if (result.status === "done" && result.result) {
        const { imported, errors, cancelled } = result.result;
        if (cancelled) toast.info(t("library.importCancelled", { count: imported.length }));
        else if (errors.length === 0) toast.success(t("library.importDone", { count: imported.length }));
        else toast.warning(t("library.importPartial", { ok: imported.length, err: errors.length }), {
          description: errors.slice(0, 3).map(([p, e]) => `${p}: ${e}`).join("\n"),
        });
      } else {
        toast.error(t("common.error"), { description: result.error });
      }
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    } finally {
      setImporting(false);
    }
    refresh();
  };

  // Drag-drop: Tauri emits window drag events with absolute file paths.
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent((e) => {
      if (e.payload.type === "over") setDragOver(true);
      else if (e.payload.type === "leave") setDragOver(false);
      else if (e.payload.type === "drop") {
        setDragOver(false);
        void runImport(e.payload.paths);
      }
    });
    return () => { void unlisten.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFiles = async () => {
    const selected = await openDialog({ multiple: true, title: t("library.importTitle"), filters: MEDIA_FILTERS });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    void runImport(paths);
  };

  const relink = async (a: AssetSummary) => {
    const selected = await openDialog({ title: t("library.relinkTitle", { name: a.name }) });
    if (typeof selected !== "string" || !selected) return;
    try {
      await api.relinkAsset(a.id, selected);
      toast.success(t("library.relinked"));
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const createCollection = async () => {
    const name = newCollection.trim();
    if (!name) return;
    try {
      await api.createCollection(name);
      setNewCollection("");
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const addTag = async () => {
    const tag = tagInput.trim();
    if (!tag || !tagTarget) return;
    try {
      await api.tagAsset(tagTarget.id, tag);
      setTagTarget(null);
      setTagInput("");
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const missingCount = useMemo(
    () => assets.data?.filter((a) => a.status === "missing").length ?? 0,
    [assets.data],
  );

  const sideItem = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
      active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
    );

  return (
    <div className="flex h-full">
      {/* Sidebar: views + collections + tags */}
      <aside className="flex w-44 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3 text-sidebar-foreground">
        <button className={sideItem(!filter.favorites && !filter.collectionId && !filter.tagId)} onClick={() => setFilter((f) => ({ ...f, favorites: false, collectionId: null, tagId: null }))}>
          <Folder className="size-4" /> {t("library.allAssets")}
        </button>
        <button className={sideItem(filter.favorites)} onClick={() => setFilter((f) => ({ ...f, favorites: true, collectionId: null, tagId: null }))}>
          <Star className="size-4" /> {t("library.favorites")}
        </button>

        <div className="mt-3 flex items-center justify-between px-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("library.collections")}
        </div>
        {collections.data?.map((c) => (
          <div key={c.id} className="group/coll flex items-center">
            <button className={cn(sideItem(filter.collectionId === c.id), "flex-1")} onClick={() => setFilter((f) => ({ ...f, collectionId: c.id, favorites: false, tagId: null }))}>
              <Folder className="size-4" />
              <span className="flex-1 truncate">{c.name}</span>
              <span className="text-2xs text-muted-foreground">{c.assetCount}</span>
            </button>
            <button
              className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover/coll:opacity-100"
              onClick={() => void api.deleteCollection(c.id).then(refresh)}
              title={t("library.deleteCollection")}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <div className="mt-1 flex gap-1 px-1">
          <Input
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createCollection()}
            placeholder={t("library.newCollection")}
            className="h-7 border-sidebar-border bg-transparent text-xs"
          />
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => void createCollection()}>
            <Plus className="size-3.5" />
          </Button>
        </div>

        {!!tags.data?.length && (
          <>
            <div className="mt-3 px-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("library.tags")}
            </div>
            {tags.data.map((tag) => (
              <button key={tag.id} className={sideItem(filter.tagId === tag.id)} onClick={() => setFilter((f) => ({ ...f, tagId: tag.id, favorites: false, collectionId: null }))}>
                <Tag className="size-4" />
                <span className="flex-1 truncate">{tag.name}</span>
                <span className="text-2xs text-muted-foreground">{tag.assetCount}</span>
              </button>
            ))}
          </>
        )}
      </aside>

      {/* Main */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col p-6 transition-colors",
          dragOver && "bg-accent/30 outline-dashed outline-2 -outline-offset-8 outline-primary",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">{t("library.title")}</h1>
          <Button onClick={() => void pickFiles()} disabled={importing}>
            {importing ? (<><Loader2 className="animate-spin" />{Math.round(importProgress * 100)}%</>) : (<><Upload />{t("library.import")}</>)}
          </Button>
        </div>

        {missingCount > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <AlertTriangle className="size-4 text-destructive" />
            {t("library.missingBanner", { count: missingCount })}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <div className="flex gap-1">
            {KIND_FILTERS.map((k) => (
              <button
                key={k}
                onClick={() => setFilter((f) => ({ ...f, kind: k }))}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  filter.kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {t(`library.kind.${k}`)}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-56">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("library.searchPlaceholder")} className="pl-8" />
          </div>
        </div>

        <div className="mt-4 flex-1 overflow-auto scrollbar-slim">
          {assets.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : !assets.data?.length ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
              <FolderPlus className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">{t("library.empty")}</p>
              <p className="text-sm text-muted-foreground">{t("library.emptyHint")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {assets.data.map((a) => (
                <AssetCard
                  key={a.id}
                  asset={a}
                  collections={collections.data ?? []}
                  onRelink={(x) => void relink(x)}
                  onDelete={setDeleteTarget}
                  onFav={(x) => void api.setAssetFavorite(x.id, !x.isFavorite).then(refresh)}
                  onAssign={(x, cid) => void api.assignToCollection(x.id, cid).then(refresh)}
                  onTag={setTagTarget}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tag dialog */}
      <Dialog open={!!tagTarget} onOpenChange={(v) => !v && setTagTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("library.addTag")}</DialogTitle>
            <DialogDescription>{tagTarget?.name}</DialogDescription>
          </DialogHeader>
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addTag()}
            placeholder={t("library.tagPlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTagTarget(null)}>{t("common.cancel")}</Button>
            <Button onClick={() => void addTag()} disabled={!tagInput.trim()}>{t("common.apply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("library.deleteTitle", { name: deleteTarget?.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("library.deleteDesc")}</AlertDialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void api.deleteAsset(deleteTarget!.id).then(() => { setDeleteTarget(null); refresh(); })}>
              {t("library.delete")}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
