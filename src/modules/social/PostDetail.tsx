import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Clapperboard,
  ExternalLink,
  FileVideo,
  FolderOpen,
  Loader2,
  Pencil,
  Send,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/ipc";
import { useOpenInEditor } from "@/lib/open-in-editor";
import { awaitJob } from "@/services/jobs";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
  type Finding,
  type SocialPostTarget,
} from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { ValidationPanel } from "./ValidationPanel";
import { PlatformIcon } from "./PlatformIcon";
import { fmtDbTime, openExternal } from "./format";
import { reportError } from "@/lib/errors";

/** Post detail: per-target export/publish pipeline + attempts + validation. */
export function PostDetail({
  postId,
  onClose,
  onEdit,
  onGoAccounts,
}: {
  postId: string;
  onClose: () => void;
  onEdit?: () => void;
  onGoAccounts?: () => void;
}) {
  const { accounts } = useSocial();
  const { t: tr } = useTranslation();
  const { openById, run } = useOpenInEditor();
  const { data: post, refetch } = useQuery({
    queryKey: ["social-post", postId],
    queryFn: () => api.getSocialPost(postId),
  });
  const { data: previews } = useQuery({
    queryKey: ["social-thumbs"],
    queryFn: () => api.socialPostPreviews(),
  });
  const [busy, setBusy] = useState<string | null>(null);

  if (!post) return null;
  const preview = previews?.[postId];

  const exportTarget = async (t: SocialPostTarget) => {
    const outDir = await open({ directory: true, title: tr("social.d_chooseFolder") });
    if (!outDir) return;
    setBusy(t.id);
    try {
      const jobId = await api.exportForTarget(t.id, outDir);
      const fin = await awaitJob<{ assetId?: string }>(jobId);
      if (fin.status === "done") {
        toast.success(tr("social.exportLinked", { platform: PLATFORM_LABEL[t.platform] }));
      } else {
        toast.error(fin.error ?? tr("social.exportFailed"));
      }
    } finally {
      setBusy(null);
      void refetch();
    }
  };

  const pickFile = async (t: SocialPostTarget) => {
    const f = await open({
      title: tr("social.d_pickFile"),
      filters: [{ name: tr("social.d_mediaFilter"), extensions: ["mp4", "mov", "mkv", "webm", "jpg", "png"] }],
    });
    if (!f || Array.isArray(f)) return;
    setBusy(t.id);
    try {
      const jobId = await api.importMedia([f]);
      const fin = await awaitJob<{
        imported?: { id: string }[];
      }>(jobId);
      const asset = fin.result?.imported?.[0];
      if (asset) {
        await api.linkTargetMedia(t.id, asset.id);
        toast.success(tr("social.fileLinked"));
      }
    } finally {
      setBusy(null);
      void refetch();
    }
  };

  const publish = async (t: SocialPostTarget) => {
    setBusy(t.id);
    try {
      const jobId = await api.publishPostTarget(t.id);
      const fin = await awaitJob<{ url?: string }>(jobId);
      if (fin.status === "done") {
        toast.success(
          fin.result?.url
            ? tr("social.d_published", { url: fin.result.url })
            : tr("social.d_uploadAccepted"),
        );
      } else {
        toast.error(fin.error ?? tr("social.publishFailed"));
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
      void refetch();
    }
  };

  const onFix = (f: Finding, targetId: string): boolean => {
    if (f.fixAction === "openCaptions" && onEdit) {
      onEdit();
      return true;
    }
    if (f.fixAction === "connectAccount" && onGoAccounts) {
      onGoAccounts();
      return true;
    }
    if (f.fixAction === "pickFile") {
      const t = post.targets.find((x) => x.id === targetId);
      if (t) void pickFile(t);
      return true;
    }
    return false;
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="min-w-0 truncate">
              {post.title || tr("social.untitled")}
            </span>
            <div className="ml-auto mr-6 flex shrink-0 gap-1.5">
              {onEdit && (
                <Button size="sm" variant="outline" onClick={onEdit}>
                  <Pencil className="mr-1 size-3" />
                  {tr("social.edit")}
                </Button>
              )}
              {post.projectId && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => run(() => openById(post.projectId!))}
                >
                  <Clapperboard className="mr-1 size-3" />
                  {tr("nav.openInEditor")}
                </Button>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="flex items-start gap-3">
            <div className="flex aspect-video w-40 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
              {preview ? (
                <img
                  src={convertFileSrc(preview)}
                  alt={tr("social.d_previewAlt")}
                  className="size-full object-cover"
                />
              ) : (
                <FileVideo className="size-6 text-muted-foreground" />
              )}
            </div>
            {post.caption && (
              <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {post.caption}
              </p>
            )}
          </div>

          {post.targets.map((t) => {
            const acct = accounts.find((a) => a.id === t.accountId);
            return (
              <TargetRow
                key={t.id}
                target={t}
                accountName={acct?.displayName ?? null}
                busy={busy === t.id}
                onExport={() => void exportTarget(t)}
                onPickFile={() => void pickFile(t)}
                onPublish={() => void publish(t)}
                onStatus={(s) => {
                  void api.setTargetStatus(t.id, s).then(() => refetch());
                }}
              />
            );
          })}
          {post.targets.length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              {tr("social.d_noTargets")}
            </p>
          )}

          <ValidationPanel postId={postId} onFix={onFix} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TargetRow({
  target: t,
  accountName,
  busy,
  onExport,
  onPickFile,
  onPublish,
  onStatus,
}: {
  target: SocialPostTarget;
  accountName: string | null;
  busy: boolean;
  onExport: () => void;
  onPickFile: () => void;
  onPublish: () => void;
  onStatus: (s: string) => void;
}) {
  const { t: tr, i18n } = useTranslation();
  const { data: attempts } = useQuery({
    queryKey: ["attempts", t.id],
    queryFn: () => api.listPublicationAttempts(t.id),
  });
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <PlatformIcon platform={t.platform} />
          {PLATFORM_LABEL[t.platform]}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] uppercase",
            t.status === "published"
              ? "bg-success/15 text-success"
              : t.status === "failed"
                ? "bg-destructive/15 text-destructive"
                : "bg-muted text-muted-foreground",
          )}
        >
          {tr(`social.st_${t.status}`, { defaultValue: t.status })}
        </span>
        <span className="flex-1" />
        {t.platformUrl && (
          <button
            type="button"
            onClick={() => void openExternal(t.platformUrl!)}
            title={t.platformUrl}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:underline"
          >
            {tr("social.d_view")} <ExternalLink className="size-2.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>
          {tr("social.d_account", { name: accountName ?? tr("social.d_none") })}
          {t.versionId ? ` · ${tr("social.d_version", { id: t.versionId })}` : ""}
          {t.scheduledAt
            ? ` · ${new Date(t.scheduledAt).toLocaleString(i18n.language)}`
            : ""}
          {t.autoPublish ? ` · ⚡${tr("social.d_auto")}` : ""}
        </span>
      </div>
      {t.lastError && (
        <p className="rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          {t.lastError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        <Button size="sm" variant="secondary" onClick={onExport} disabled={busy}>
          <Upload className="mr-1 size-3" />
          {t.exportAssetId ? tr("social.d_reExport") : tr("social.d_export")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onPickFile} disabled={busy}>
          <FolderOpen className="mr-1 size-3" /> {tr("social.d_linkFile")}
        </Button>
        {t.exportAssetId && (
          <LinkedFile assetId={t.exportAssetId} />
        )}
        {t.status === "published" ? null : (
          <Button
            size="sm"
            onClick={onPublish}
            disabled={busy || !t.exportAssetId || !t.accountId}
            title={
              !t.accountId
                ? tr("social.d_tipNoAccount")
                : !t.exportAssetId
                  ? tr("social.d_tipNoExport")
                  : tr("social.d_tipReady")
            }
          >
            <Send className="mr-1 size-3" /> {tr("social.d_publishNow")}
          </Button>
        )}
        {t.status === "publishing" && (
          <Button size="sm" variant="ghost" onClick={() => onStatus("cancelled")}>
            {tr("social.d_cancel")}
          </Button>
        )}
      </div>

      {/* attempt history — real audit trail */}
      {(attempts ?? []).length > 0 && (
        <div className="space-y-0.5 border-t border-border pt-1.5">
          {(attempts ?? []).map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 text-[10px] text-muted-foreground"
            >
              <span>#{a.attemptNo}</span>
              <span
                className={cn(
                  a.status === "published" && "text-success",
                  a.status === "failed" && "text-destructive",
                )}
              >
                {tr(`pubhist.st_${a.status}`, { defaultValue: a.status })}
              </span>
              <span>{fmtDbTime(a.startedAt, i18n.language)}</span>
              {a.error && <span className="truncate">{a.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedFile({ assetId }: { assetId: string }) {
  const { t: tr } = useTranslation();
  const { data: assets } = useQuery({
    queryKey: ["linked-asset", assetId],
    queryFn: async () => {
      const all = await api.listAssets();
      return all.find((a) => a.id === assetId) ?? null;
    },
  });
  if (!assets) return null;
  return (
    <button
      onClick={() => void api.revealPath(assets.filePath)}
      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
      title={assets.filePath}
    >
      <FolderOpen className="size-2.5" />
      {assets.name}
      {assets.status === "missing" && (
        <span className="text-destructive">{tr("social.missing")}</span>
      )}
    </button>
  );
}
