import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ExternalLink,
  FolderOpen,
  Loader2,
  Send,
  Upload,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
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

/** Post detail: per-target export/publish pipeline + attempts + validation. */
export function PostDetail({
  postId,
  onClose,
}: {
  postId: string;
  onClose: () => void;
}) {
  const { accounts } = useSocial();
  const { data: post, refetch } = useQuery({
    queryKey: ["social-post", postId],
    queryFn: () => api.getSocialPost(postId),
  });
  const [busy, setBusy] = useState<string | null>(null);

  if (!post) return null;

  const exportTarget = async (t: SocialPostTarget) => {
    const outDir = await open({ directory: true, title: "Choose export folder" });
    if (!outDir) return;
    setBusy(t.id);
    try {
      const jobId = await api.exportForTarget(t.id, outDir);
      const fin = await awaitJob<{ assetId?: string }>(jobId);
      if (fin.status === "done") {
        toast.success(`${PLATFORM_LABEL[t.platform]} export linked`);
      } else {
        toast.error(fin.error ?? "export failed");
      }
    } finally {
      setBusy(null);
      void refetch();
    }
  };

  const pickFile = async (t: SocialPostTarget) => {
    const f = await open({
      title: "Pick exported media file",
      filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "jpg", "png"] }],
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
        toast.success("File linked");
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
            ? `Published: ${fin.result.url}`
            : "Upload accepted by platform",
        );
      } else {
        toast.error(fin.error ?? "publish failed");
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
      void refetch();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="text-sm">
            {post.title || "Untitled post"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {post.caption && (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {post.caption}
            </p>
          )}

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
              No platform targets — edit the post to add some.
            </p>
          )}

          <ValidationPanel postId={postId} />
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
  const { data: attempts } = useQuery({
    queryKey: ["attempts", t.id],
    queryFn: () => api.listPublicationAttempts(t.id),
  });
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">{PLATFORM_LABEL[t.platform]}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] uppercase",
            t.status === "published"
              ? "bg-green-500/15 text-green-400"
              : t.status === "failed"
                ? "bg-red-500/15 text-red-400"
                : "bg-muted text-muted-foreground",
          )}
        >
          {t.status}
        </span>
        <span className="flex-1" />
        {t.platformUrl && (
          <a
            href={t.platformUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 text-[10px] text-primary hover:underline"
          >
            view <ExternalLink className="size-2.5" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>
          account: {accountName ?? "none"}
          {t.versionId ? ` · version: ${t.versionId}` : ""}
          {t.scheduledAt ? ` · ${new Date(t.scheduledAt).toLocaleString()}` : ""}
          {t.autoPublish ? " · ⚡auto" : ""}
        </span>
      </div>
      {t.lastError && (
        <p className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-400">
          {t.lastError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        <Button size="sm" variant="secondary" onClick={onExport} disabled={busy}>
          <Upload className="mr-1 size-3" />
          {t.exportAssetId ? "Re-export" : "Export for platform"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onPickFile} disabled={busy}>
          <FolderOpen className="mr-1 size-3" /> Link file
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
                ? "connect an account first"
                : !t.exportAssetId
                  ? "export or link a file first"
                  : "Upload to platform now"
            }
          >
            <Send className="mr-1 size-3" /> Publish now
          </Button>
        )}
        {t.status === "publishing" && (
          <Button size="sm" variant="ghost" onClick={() => onStatus("cancelled")}>
            Cancel
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
                  a.status === "published" && "text-green-400",
                  a.status === "failed" && "text-red-400",
                )}
              >
                {a.status}
              </span>
              <span>{a.startedAt.replace("T", " ").slice(0, 16)}</span>
              {a.error && <span className="truncate">{a.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedFile({ assetId }: { assetId: string }) {
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
        <span className="text-red-400">(missing)</span>
      )}
    </button>
  );
}
