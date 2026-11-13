import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  CalendarDays,
  Copy,
  ExternalLink,
  FileVideo,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { onJobFinished } from "@/services/jobs";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
  type SocialPost,
  type SocialPostTarget,
} from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ComposerDialog } from "./ComposerDialog";
import { CalendarView } from "./CalendarView";
import { AccountsPanel } from "./AccountsPanel";
import { PostDetail } from "./PostDetail";

type Tab = "posts" | "calendar" | "accounts";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-blue-500/15 text-blue-400",
  scheduled: "bg-warning/15 text-warning",
  publishing: "bg-purple-500/15 text-purple-400 animate-pulse",
  published: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function SocialPage() {
  const { t } = useTranslation();
  const {
    posts,
    loaded,
    statusFilter,
    platformFilter,
    search,
    setStatusFilter,
    setPlatformFilter,
    setSearch,
    refreshAll,
    refreshPosts,
  } = useSocial();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(
    ["posts", "calendar", "accounts"].includes(params.get("tab") ?? "")
      ? (params.get("tab") as Tab)
      : "posts",
  );
  const [composing, setComposing] = useState<null | { id?: string }>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Reminder events: local scheduler pings when a non-auto target is due.
  useEffect(() => {
    const un = listen<{ title: string; platform: string }>(
      "social://due",
      (e) =>
        toast.warning(
          `“${e.payload.title}” is due on ${PLATFORM_LABEL[e.payload.platform as never] ?? e.payload.platform} — publish it manually`,
        ),
    );
    const un2 = listen<{ platform: string; error?: string }>(
      "social://oauth-finished",
      (e) => {
        if (e.payload.error) {
          toast.error(`OAuth failed: ${e.payload.error}`);
        } else {
          toast.success("Account connected");
        }
        void useSocial.getState().refreshAccounts();
      },
    );
    return () => {
      void un.then((f) => f());
      void un2.then((f) => f());
    };
  }, []);

  // Refresh list when social jobs finish (export or publish).
  useEffect(
    () =>
      onJobFinished(() => {
        void refreshPosts();
      }),
    [refreshPosts],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of posts) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [posts]);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">Social Studio</h1>
        <div className="ml-2 flex rounded-md border border-input p-0.5 text-xs">
          {(
            [
              ["posts", FileVideo],
              ["calendar", CalendarDays],
              ["accounts", Users],
            ] as const
          ).map(([k, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                "flex items-center gap-1 rounded px-2.5 py-1 capitalize",
                tab === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              <Icon className="size-3.5" /> {k}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void refreshPosts()}>
          <RefreshCw className="size-3.5" />
        </Button>
        {tab === "posts" && (
          <Button size="sm" onClick={() => setComposing({})}>
            <Plus className="mr-1 size-3.5" /> New post
          </Button>
        )}
      </div>

      {tab === "posts" && (
        <>
          {/* filters */}
          <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-xs">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void refreshPosts()}
              placeholder={t("common.search")}
              className="h-7 w-52 rounded border border-input bg-background px-2 text-xs"
            />
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setTimeout(refreshPosts);
              }}
              className="h-7 rounded border border-input bg-background px-2 text-xs"
            >
              <option value="">All statuses</option>
              {["draft", "ready", "scheduled", "publishing", "published", "failed"].map(
                (s) => (
                  <option key={s} value={s}>
                    {s} {counts[s] ? `(${counts[s]})` : ""}
                  </option>
                ),
              )}
            </select>
            <select
              value={platformFilter}
              onChange={(e) => {
                setPlatformFilter(e.target.value as never);
                setTimeout(refreshPosts);
              }}
              className="h-7 rounded border border-input bg-background px-2 text-xs"
            >
              <option value="">All platforms</option>
              {Object.entries(PLATFORM_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          {/* list */}
          <div className="flex-1 overflow-y-auto p-5">
            {posts.length === 0 ? (
              <EmptyState onNew={() => setComposing({})} />
            ) : (
              <div className="grid gap-3">
                {posts.map((p) => (
                  <PostCard
                    key={p.id}
                    post={p}
                    onOpen={() => setDetailId(p.id)}
                    onEdit={() => setComposing({ id: p.id })}
                    onDuplicate={async () => {
                      await api.duplicateSocialPost(p.id);
                      void refreshPosts();
                    }}
                    onDelete={async () => {
                      await api.deleteSocialPost(p.id);
                      toast.success("Post deleted");
                      void refreshPosts();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "calendar" && <CalendarView onOpenPost={setDetailId} />}
      {tab === "accounts" && <AccountsPanel />}

      {composing && (
        <ComposerDialog
          postId={composing.id}
          onClose={() => {
            setComposing(null);
            void refreshPosts();
          }}
        />
      )}
      {detailId && (
        <PostDetail postId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">
        No social posts yet. Package an exported video for your platforms.
      </p>
      <Button size="sm" onClick={onNew}>
        <Plus className="mr-1 size-3.5" /> New post
      </Button>
    </div>
  );
}

function PostCard({
  post,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  post: SocialPost;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="cursor-pointer rounded-lg border border-border bg-card p-4 hover:border-primary/50"
      onClick={onOpen}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                STATUS_BADGE[post.status],
              )}
            >
              {post.status}
            </span>
            <span className="truncate text-sm font-medium">
              {post.title || "Untitled post"}
            </span>
          </div>
          {post.caption && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
              {post.caption}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {post.targets.map((t) => (
              <TargetChip key={t.id} target={t} />
            ))}
            {post.targets.length === 0 && (
              <span className="text-[10px] italic text-muted-foreground">
                no platforms selected
              </span>
            )}
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
            <Pencil className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDuplicate} title="Duplicate">
            <Copy className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function TargetChip({ target }: { target: SocialPostTarget }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px]",
        STATUS_BADGE[target.status],
      )}
      title={target.lastError ?? undefined}
    >
      {PLATFORM_LABEL[target.platform]}
      {target.platformUrl && (
        <a
          href={target.platformUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-2.5" />
        </a>
      )}
    </span>
  );
}
