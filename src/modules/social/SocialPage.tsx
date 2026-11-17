import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  CalendarDays,
  Copy,
  ExternalLink,
  FileVideo,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  Share2,
} from "lucide-react";
import { EmptyState as SharedEmptyState } from "@/components/EmptyState";
import { api } from "@/lib/ipc";
import { onJobFinished } from "@/services/jobs";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
  type SocialPost,
  type SocialPostTarget,
} from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import {
  AnchoredMenu,
  AnchoredMenuItem,
} from "@/components/ui/anchored-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SuggestionBanner } from "@/components/SuggestionBanner";
import { useProject } from "@/stores/project";
import { cn } from "@/lib/utils";
import { reportError } from "@/lib/errors";
import { ComposerDialog } from "./ComposerDialog";
import { CalendarView } from "./CalendarView";
import { AccountsPanel } from "./AccountsPanel";
import { PublicationHistory } from "./PublicationHistory";
import { PostDetail } from "./PostDetail";

type Tab = "posts" | "calendar" | "accounts" | "history";

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
  const doc = useProject((s) => s.doc);
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
    ["posts", "calendar", "accounts", "history"].includes(params.get("tab") ?? "")
      ? (params.get("tab") as Tab)
      : "posts",
  );
  const [composing, setComposing] = useState<null | { id?: string }>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SocialPost | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Live search: debounce keystrokes instead of requiring Enter.
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) {
      firstSearch.current = false;
      return;
    }
    const id = setTimeout(() => void refreshPosts(), 300);
    return () => clearTimeout(id);
  }, [search, refreshPosts]);

  // Card thumbnails: the post's own thumbnail, else the first exported file.
  const { data: thumbs } = useQuery({
    queryKey: ["social-thumbs"],
    queryFn: async () => {
      const m = new Map<string, string>();
      for (const a of await api.listAssets())
        if (a.thumbnailPath) m.set(a.id, a.thumbnailPath);
      return m;
    },
  });
  const thumbOf = (p: SocialPost) => {
    const id =
      p.thumbnailAssetId ?? p.targets.find((x) => x.exportAssetId)?.exportAssetId;
    return (id && thumbs?.get(id)) || null;
  };

  // Reminder events: local scheduler pings when a non-auto target is due.
  useEffect(() => {
    const un = listen<{ title: string; platform: string }>(
      "social://due",
      (e) =>
        toast.warning(
          t("social.dueReminder", {
            title: e.payload.title,
            platform:
              PLATFORM_LABEL[e.payload.platform as never] ?? e.payload.platform,
          }),
        ),
    );
    const un2 = listen<{ platform: string; error?: string }>(
      "social://oauth-finished",
      (e) => {
        if (e.payload.error) {
          toast.error(t("social.oauthFailed"), { description: e.payload.error });
        } else {
          toast.success(t("social.accountConnected"));
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
        void qc.invalidateQueries({ queryKey: ["social-thumbs"] });
      }),
    [refreshPosts, qc],
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
        <h1 className="text-base font-semibold">{t("social.studio")}</h1>
        <div className="ml-2 flex rounded-md border border-input p-0.5 text-xs">
          {(
            [
              ["posts", FileVideo],
              ["calendar", CalendarDays],
              ["accounts", Users],
              ["history", History],
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
              <Icon className="size-3.5" /> {t(`social.tab_${k}`)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          title={t("social.refresh")}
          aria-label={t("social.refresh")}
          onClick={() => void refreshPosts()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        {tab === "posts" && (
          <Button size="sm" onClick={() => setComposing({})}>
            <Plus className="mr-1 size-3.5" /> {t("social.newPost")}
          </Button>
        )}
      </div>

      <SuggestionBanner doc={doc} only={["prepare-publish", "thumbnail-to-post"]} />

      {tab === "posts" && (
        <>
          {/* filters */}
          <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-xs">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void refreshPosts()}
              placeholder={t("common.search")}
              aria-label={t("common.search")}
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
              <option value="">{t("social.allStatuses")}</option>
              {["draft", "ready", "scheduled", "publishing", "published", "failed", "cancelled"].map(
                (s) => (
                  <option key={s} value={s}>
                    {t(`social.st_${s}`)} {counts[s] ? `(${counts[s]})` : ""}
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
              <option value="">{t("social.allPlatforms")}</option>
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
                    thumb={thumbOf(p)}
                    onOpen={() => setDetailId(p.id)}
                    onEdit={() => setComposing({ id: p.id })}
                    onDuplicate={async () => {
                      await api.duplicateSocialPost(p.id);
                      void refreshPosts();
                    }}
                    onDelete={() => setDeleting(p)}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "calendar" && <CalendarView onOpenPost={setDetailId} />}
      {tab === "accounts" && <AccountsPanel />}
      {tab === "history" && (
        <PublicationHistory
          onOpenPost={(id) => {
            setDetailId(id);
            setTab("posts");
          }}
        />
      )}

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

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("social.deleteTitle", {
              title: deleting?.title || t("social.untitled"),
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("social.deleteDesc")}</AlertDialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogCancel onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const id = deleting!.id;
                setDeleting(null);
                try {
                  await api.deleteSocialPost(id);
                  toast.success(t("social.postDeleted"));
                } catch (e) {
                  reportError(e);
                }
                void refreshPosts();
              }}
            >
              {t("social.delete")}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <SharedEmptyState
      icon={Share2}
      title={t("social.emptyTitle")}
      body={t("social.emptyBody")}
      action={{ label: t("social.newPost"), onClick: onNew }}
    />
  );
}

function PostCard({
  post,
  thumb,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  post: SocialPost;
  thumb: string | null;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      className="cursor-pointer rounded-lg border border-border bg-card p-4 outline-none hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex aspect-video w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
          {thumb ? (
            <img
              src={convertFileSrc(thumb)}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <FileVideo className="size-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                STATUS_BADGE[post.status],
              )}
            >
              {t(`social.st_${post.status}`, { defaultValue: post.status })}
            </span>
            <span className="truncate text-sm font-medium">
              {post.title || t("social.untitled")}
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
                {t("social.noPlatforms")}
              </span>
            )}
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <Button size="sm" variant="ghost" onClick={onEdit} title={t("social.edit")} aria-label={t("social.edit")}>
            <Pencil className="size-3.5" />
          </Button>
          <Button
            ref={moreRef}
            size="sm"
            variant="ghost"
            title={t("social.more")}
            aria-label={t("social.more")}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
          <AnchoredMenu
            open={menu}
            onClose={() => setMenu(false)}
            anchor={moreRef}
            side="bottom"
            align="end"
            className="w-40 rounded-md border border-border bg-popover p-1 shadow-xl"
          >
            <AnchoredMenuItem
              onClick={() => {
                setMenu(false);
                onDuplicate();
              }}
            >
              <Copy className="size-3.5" /> {t("social.duplicate")}
            </AnchoredMenuItem>
            <AnchoredMenuItem
              destructive
              onClick={() => {
                setMenu(false);
                onDelete();
              }}
            >
              <Trash2 className="size-3.5" /> {t("social.delete")}
            </AnchoredMenuItem>
          </AnchoredMenu>
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
