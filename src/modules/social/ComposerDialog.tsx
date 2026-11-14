import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { api } from "@/lib/ipc";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
  type TargetInput,
} from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CaptionStudio } from "./CaptionStudio";
import { ValidationPanel } from "./ValidationPanel";
import { useTranslation } from "react-i18next";

interface DraftTarget extends TargetInput {
  enabled: boolean;
}

export function ComposerDialog({
  postId,
  onClose,
}: {
  postId?: string;
  onClose: () => void;
}) {
  const { t: tr } = useTranslation();
  const { accounts, capabilities } = useSocial();
  const [saving, setSaving] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, DraftTarget>>({});
  const [createdId, setCreatedId] = useState<string | null>(postId ?? null);

  const { data: projectList } = useQuery({
    queryKey: ["projects-social"],
    queryFn: () => api.listProjects(),
  });
  // Load existing post for edit mode.
  useEffect(() => {
    if (!postId) return;
    void api.getSocialPost(postId).then((p) => {
      setProjectId(p.projectId);
      setTitle(p.title);
      setCaption(p.caption);
      setHashtags(p.hashtags);
      const t: Record<string, DraftTarget> = {};
      for (const tg of p.targets) {
        t[tg.platform] = {
          enabled: true,
          platform: tg.platform,
          accountId: tg.accountId,
          versionId: tg.versionId,
          title: tg.title,
          caption: tg.caption,
          hashtags: tg.hashtags,
          platformMeta: tg.platformMeta,
          scheduledAt: tg.scheduledAt,
          autoPublish: tg.autoPublish,
        };
      }
      setTargets(t);
    });
  }, [postId]);

  const enabledPlatforms = useMemo(
    () => SOCIAL_PLATFORMS.filter((p) => targets[p]?.enabled),
    [targets],
  );

  const toggle = (p: SocialPlatform) =>
    setTargets((t) => ({
      ...t,
      [p]: { platform: p, enabled: !t[p]?.enabled },
    }));

  const setT = (p: SocialPlatform, patch: Partial<DraftTarget>) =>
    setTargets((t) => ({ ...t, [p]: { ...t[p]!, ...patch } }));

  const save = async (markReady: boolean) => {
    if (!title.trim()) {
      toast.error(tr("social.titleRequired"));
      return;
    }
    setSaving(true);
    try {
      const input = {
        projectId,
        title,
        caption,
        hashtags,
        targets: enabledPlatforms.map((p) => {
          const t = targets[p]!;
          return {
            platform: p,
            accountId: t.accountId ?? null,
            versionId: t.versionId ?? null,
            title: t.title ?? null,
            caption: t.caption ?? null,
            hashtags: t.hashtags ?? null,
            platformMeta: t.platformMeta ?? {},
            scheduledAt: t.scheduledAt ?? null,
            autoPublish: t.autoPublish ?? false,
          };
        }),
      };
      const post = createdId
        ? await api.updateSocialPost(createdId, input)
        : await api.createSocialPost(input);
      setCreatedId(post.id);
      // Upsert each enabled target so schedule/overrides persist.
      for (const p of enabledPlatforms) {
        const t = targets[p]!;
        const saved = await api.upsertPostTarget(post.id, {
          platform: p,
          accountId: t.accountId ?? null,
          versionId: t.versionId ?? null,
          title: t.title ?? null,
          caption: t.caption ?? null,
          hashtags: t.hashtags ?? null,
          platformMeta: t.platformMeta ?? {},
          scheduledAt: t.scheduledAt ?? null,
          autoPublish: t.autoPublish ?? false,
        });
        if (markReady && saved.status === "draft") {
          await api.setTargetStatus(saved.id, "ready");
        }
      }
      toast.success(markReady ? tr("social.postReady") : tr("social.draftSaved"));
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="text-sm">
            {postId ? "Edit post" : "New social post"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid flex-1 grid-cols-[1fr_300px] gap-0 overflow-hidden">
          {/* left: post + targets */}
          <div className="space-y-4 overflow-y-auto p-5">
            {/* project link */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Source project
              </label>
              <select
                value={projectId ?? ""}
                onChange={(e) => setProjectId(e.target.value || null)}
                className="h-8 w-full rounded border border-input bg-background px-2 text-xs"
              >
                <option value="">{tr("social.noProjectOpt")}</option>
                {(projectList ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* platforms */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Platforms
              </label>
              <div className="flex flex-wrap gap-1.5">
                {SOCIAL_PLATFORMS.map((p) => (
                  <button
                    key={p}
                    onClick={() => toggle(p)}
                    className={cn(
                      "flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs",
                      targets[p]?.enabled
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {targets[p]?.enabled && <CheckCircle2 className="size-3" />}
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>

            {/* per-target cards */}
            {enabledPlatforms.map((p) => {
              const t = targets[p]!;
              const platAccounts = accounts.filter(
                (a) => a.platform === p && a.status === "active",
              );
              const cap = capabilities.find((c) => c.platform === p);
              return (
                <div
                  key={p}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">
                      {PLATFORM_LABEL[p]}
                    </span>
                    {cap?.requiresAppReview && (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">
                        needs approved app
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="space-y-0.5">
                      <span className="text-muted-foreground">{tr("social.account")}</span>
                      <select
                        value={t.accountId ?? ""}
                        onChange={(e) =>
                          setT(p, { accountId: e.target.value || null })
                        }
                        className="h-7 w-full rounded border border-input bg-background px-1.5"
                      >
                        <option value="">{tr("social.noneLocal")}</option>
                        {platAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.displayName ?? a.platformUserId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-0.5">
                      <span className="text-muted-foreground">
                        Format version
                      </span>
                      <VersionSelect
                        projectId={projectId}
                        value={t.versionId ?? ""}
                        onChange={(v) => setT(p, { versionId: v || null })}
                      />
                    </label>
                  </div>
                  <label className="block space-y-0.5 text-xs">
                    <span className="text-muted-foreground">
                      Title override (blank = shared)
                    </span>
                    <input
                      value={t.title ?? ""}
                      onChange={(e) => setT(p, { title: e.target.value })}
                      placeholder={title || "Title"}
                      className="h-7 w-full rounded border border-input bg-background px-2"
                    />
                  </label>
                  <div className="flex items-end gap-2 text-xs">
                    <label className="flex-1 space-y-0.5">
                      <span className="text-muted-foreground">
                        Schedule (local)
                      </span>
                      <input
                        type="datetime-local"
                        value={t.scheduledAt ?? ""}
                        onChange={(e) =>
                          setT(p, { scheduledAt: e.target.value || null })
                        }
                        className="h-7 w-full rounded border border-input bg-background px-1.5"
                      />
                    </label>
                    <label className="flex items-center gap-1.5 pb-1.5">
                      <input
                        type="checkbox"
                        checked={t.autoPublish ?? false}
                        onChange={(e) =>
                          setT(p, { autoPublish: e.target.checked })
                        }
                      />
                      <span title={tr("social.autoPublishTip")}>
                        auto-publish
                      </span>
                    </label>
                  </div>
                  {p === "instagram" && (
                    <input
                      value={(t.platformMeta?.hostedUrl as string) ?? ""}
                      onChange={(e) =>
                        setT(p, {
                          platformMeta: {
                            ...t.platformMeta,
                            hostedUrl: e.target.value,
                          },
                        })
                      }
                      placeholder={tr("social.videoUrlPh")}
                      className="h-7 w-full rounded border border-input bg-background px-2"
                    />
                  )}
                  {(p === "facebook" || p === "instagram") && (
                    <input
                      value={(t.platformMeta?.pageId as string) ?? ""}
                      onChange={(e) =>
                        setT(p, {
                          platformMeta: {
                            ...t.platformMeta,
                            pageId: e.target.value,
                          },
                        })
                      }
                      placeholder={tr("social.pageIdPh")}
                      className="h-7 w-full rounded border border-input bg-background px-2"
                    />
                  )}
                  {p === "youtube" && (
                    <select
                      value={(t.platformMeta?.privacy as string) ?? "private"}
                      onChange={(e) =>
                        setT(p, {
                          platformMeta: {
                            ...t.platformMeta,
                            privacy: e.target.value,
                          },
                        })
                      }
                      className="h-7 w-full rounded border border-input bg-background px-1.5 text-xs"
                    >
                      {["private", "unlisted", "public"].map((v) => (
                        <option key={v} value={v}>
                          privacy: {v}
                        </option>
                      ))}
                    </select>
                  )}
                  {cap && (
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      {cap.statusNote}
                    </p>
                  )}
                </div>
              );
            })}

            {/* validation */}
            {createdId && (
              <ValidationPanel postId={createdId} key={createdId} />
            )}
          </div>

          {/* right: caption studio */}
          <div className="border-l border-border">
            <CaptionStudio
              title={title}
              onTitle={setTitle}
              caption={caption}
              onCaption={setCaption}
              hashtags={hashtags}
              onHashtags={setHashtags}
            />
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="mr-1 size-3.5" /> Close
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => void save(false)}
          >
            {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            Save draft
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save(true)}>
            Mark ready
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Versions of the linked project — resolved by opening its doc once. */
function VersionSelect({
  projectId,
  value,
  onChange,
}: {
  projectId: string | null;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t: tr } = useTranslation();
  const { data: versions } = useQuery({
    queryKey: ["project-versions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const summary = (await api.listProjects()).find(
        (p) => p.id === projectId,
      );
      if (!summary) return [] as { id: string; name: string }[];
      const { doc } = await api.openProject(summary.filePath);
      return doc.versions.map((v) => ({ id: v.id, name: v.name }));
    },
  });
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-full rounded border border-input bg-background px-1.5"
    >
      <option value="">{tr("social.baseCanvas")}</option>
      {(versions ?? []).map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  );
}
