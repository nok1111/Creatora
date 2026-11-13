import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Upload, Search, Film, Music, Image as ImageIcon, FileText,
  AlertTriangle, MoreVertical, Link2, Trash2, Copy, Loader2,
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

function AssetCard({ asset, onRelink, onDelete }: {
  asset: AssetSummary;
  onRelink: (a: AssetSummary) => void;
  onDelete: (a: AssetSummary) => void;
}) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[asset.kind] ?? FileText;
  const missing = asset.status === "missing";

  return (
    <div className={cn("group relative overflow-hidden rounded-lg border border-border bg-card", missing && "border-destructive/50")}>
      <div className="flex aspect-video items-center justify-center bg-secondary/50">
        {asset.thumbnailPath && !missing ? (
          <img
            src={convertFileSrc(asset.thumbnailPath)}
            alt={asset.name}
            className="size-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon className="size-8 text-muted-foreground" />
        )}
        {missing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60">
            <AlertTriangle className="size-6 text-destructive" />
            <span className="text-2xs font-medium text-destructive">{t("library.missing")}</span>
          </div>
        )}
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
          <span title={t("library.duplicate")}>
            <Copy className="size-3.5 text-muted-foreground" />
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary group-hover:opacity-100">
            <MoreVertical className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onRelink(asset)}>
              <Link2 className="size-4" /> {t("library.relink")}
            </DropdownMenuItem>
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
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<AssetSummary | null>(null);

  const assets = useQuery({
    queryKey: ["assets", kind, query],
    queryFn: () =>
      api.listAssets({
        kind: kind === "all" ? undefined : kind,
        query: query || undefined,
      }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["assets"] });

  // Missing-media sweep on mount.
  useEffect(() => {
    api.scanMissingAssets().then((n) => {
      if (n > 0) refresh();
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const importFiles = async () => {
    const selected = await openDialog({
      multiple: true,
      title: t("library.importTitle"),
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
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
        if (cancelled) {
          toast.info(t("library.importCancelled", { count: imported.length }));
        } else if (errors.length === 0) {
          toast.success(t("library.importDone", { count: imported.length }));
        } else {
          toast.warning(t("library.importPartial", {
            ok: imported.length,
            err: errors.length,
          }), {
            description: errors.slice(0, 3).map(([p, e]) => `${p}: ${e}`).join("\n"),
          });
        }
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

  const relink = async (a: AssetSummary) => {
    const selected = await openDialog({
      title: t("library.relinkTitle", { name: a.name }),
    });
    if (typeof selected !== "string" || !selected) return;
    const path = selected;
    try {
      await api.relinkAsset(a.id, path);
      toast.success(t("library.relinked"));
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteAsset(deleteTarget.id);
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const missingCount = useMemo(
    () => assets.data?.filter((a) => a.status === "missing").length ?? 0,
    [assets.data],
  );

  return (
    <div className="flex h-full flex-col p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t("library.title")}</h1>
        <Button onClick={() => void importFiles()} disabled={importing}>
          {importing ? (
            <>
              <Loader2 className="animate-spin" />
              {Math.round(importProgress * 100)}%
            </>
          ) : (
            <>
              <Upload />
              {t("library.import")}
            </>
          )}
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
              onClick={() => setKind(k)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                kind === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {t(`library.kind.${k}`)}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-56">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("library.searchPlaceholder")}
            className="pl-8"
          />
        </div>
      </div>

      <div className="mt-4 flex-1 overflow-auto scrollbar-slim">
        {assets.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : !assets.data?.length ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
            <Film className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t("library.empty")}</p>
            <p className="text-sm text-muted-foreground">{t("library.emptyHint")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {assets.data.map((a) => (
              <AssetCard key={a.id} asset={a} onRelink={(x) => void relink(x)} onDelete={setDeleteTarget} />
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("library.deleteTitle", { name: deleteTarget?.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("library.deleteDesc")}</AlertDialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void doDelete()}>
              {t("library.delete")}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
