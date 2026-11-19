import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { api } from "@/lib/ipc";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  extractHashtags,
  type Finding,
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
import { PlatformIcon } from "./PlatformIcon";
import { ValidationPanel } from "./ValidationPanel";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";

interface DraftTarget extends TargetInput {
  enabled: boolean;
  /** Raw text of the hashtags override ("" = inherit the shared hashtags). */
  hashtagsRaw?: string;
}

interface MetaLimits {
  titleMaxChars: number;
  captionMaxChars: number;
  hashtagMax: number;
}

/** Content errors the user can fix inside the composer. Media errors
 *  (missing export, aspect…) only exist after an export and never block
 *  marking a post ready. */
const BLOCKING_CODES = new Set(["title_empty", "title_too_long", "caption_too_long"]);

const parseTags = (raw: string) =>
  raw
    .split(/[\s,]+/)
    .map((x) => x.replace(/^#+/, ""))
    .filter(Boolean);

function Counter({ n, max }: { n: number; max: number }) {
  if (!max) return null;
  return (
    <span
      className={cn(
        "text-[10px]",
        n > max ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {n}/{max}
    </span>
  );
}

export function ComposerDialog({
  postId,
  onClose,
  onGoAccounts,
  defaultSchedule,
}: {
  postId?: string;
  onClose: () => void;
  onGoAccounts?: () => void;
  /** datetime-local value pre-filled on newly enabled platforms (calendar "new post on this day"). */
  defaultSchedule?: string;
}) {
  const { t: tr } = useTranslation();
  const qc = useQueryClient();
  const { accounts, capabilities } = useSocial();
  const [saving, setSaving] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, DraftTarget>>({});
  const [savedId, setSavedId] = useState<string | null>(postId ?? null);

  const { data: projectList } = useQuery({
    queryKey: ["projects-social"],
    queryFn: () => api.listProjects(),
  });
  const { data: ruleset } = useQuery({
    queryKey: ["platform-ruleset"],
    queryFn: () => api.platformRuleset(),
    staleTime: Infinity,
  });
  const limitsOf = (p: SocialPlatform): MetaLimits => {
    const plat = (ruleset?.platforms as Record<string, { metadata?: Partial<MetaLimits> }> | undefined)?.[p];
    return {
      titleMaxChars: plat?.metadata?.titleMaxChars ?? 0,
      captionMaxChars: plat?.metadata?.captionMaxChars ?? 0,
      hashtagMax: plat?.metadata?.hashtagMax ?? 0,
    };
  };

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
          hashtagsRaw: tg.hashtags?.map((h) => `#${h}`).join(" ") ?? "",
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

  // Toggling keeps the platform's configuration so off/on doesn't wipe it.
  const toggle = (p: SocialPlatform) =>
    setTargets((t) => {
      const enabling = !t[p]?.enabled;
      return {
        ...t,
        [p]: {
          ...t[p],
          platform: p,
          enabled: enabling,
          scheduledAt:
            enabling && !t[p]?.scheduledAt && defaultSchedule
              ? defaultSchedule
              : t[p]?.scheduledAt,
        },
      };
    });

  const setT = (p: SocialPlatform, patch: Partial<DraftTarget>) =>
    setTargets((t) => ({ ...t, [p]: { ...t[p]!, ...patch } }));

  const buildInput = () => ({
    projectId,
    title,
    caption,
    hashtags,
    targets: enabledPlatforms.map((p) => {
      const t = targets[p]!;
      const tags = parseTags(t.hashtagsRaw ?? "");
      return {
        platform: p,
        accountId: t.accountId ?? null,
        versionId: t.versionId ?? null,
        title: t.title?.trim() ? t.title : null,
        caption: t.caption?.trim() ? t.caption : null,
        hashtags: tags.length ? tags : null,
        platformMeta: t.platformMeta ?? {},
        scheduledAt: t.scheduledAt ?? null,
        autoPublish: t.autoPublish ?? false,
      };
    }),
  });

  const focusField = (id: string) => document.getElementById(id)?.focus();

  const onFix = (f: Finding): boolean => {
    if (f.fixAction === "openCaptions") {
      focusField(f.code.startsWith("title") ? "social-title" : "social-caption");
      return true;
    }
    if (f.fixAction === "connectAccount" && onGoAccounts) {
      onGoAccounts();
      return true;
    }
    if (f.fixAction === "pickFile") {
      toast.info(tr("social.fixPickFileHint"));
      return true;
    }
    return false;
  };

  const save = async (markReady: boolean) => {
    if (!title.trim()) {
      toast.error(tr("social.titleRequired"));
      focusField("social-title");
      return;
    }
    setSaving(true);
    try {
      const post = await api.saveSocialPost(savedId, buildInput(), false);
      setSavedId(post.id);
      await qc.invalidateQueries({ queryKey: ["validate-post", post.id] });
      void qc.invalidateQueries({ queryKey: ["social-post", post.id] });
      if (markReady) {
        const v = await api.validateSocialPost(post.id);
        const blocked = v.targets.some((t) =>
          t.findings.some((f) => f.severity === "error" && BLOCKING_CODES.has(f.code)),
        );
        if (blocked) {
          toast.error(tr("social.blockedReady"));
          return;
        }
        await api.saveSocialPost(post.id, buildInput(), true);
      }
      toast.success(markReady ? tr("social.postReady") : tr("social.draftSaved"));
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="brand-hairline relative border-b border-border px-5 py-3">
          <DialogTitle className="text-sm">
            {postId ? tr("social.composerEdit") : tr("social.composerNew")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid flex-1 grid-cols-[1fr_300px] gap-0 overflow-hidden">
          {/* left: post + targets */}
          <div className="space-y-4 overflow-y-auto p-5">
            {/* project link */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {tr("social.sourceProject")}
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
                {tr("social.platformsLbl")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {SOCIAL_PLATFORMS.map((p) => (
                  <button
                    key={p}
                    onClick={() => toggle(p)}
                    aria-pressed={!!targets[p]?.enabled}
                    className={cn(
                      "flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs",
                      targets[p]?.enabled
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <PlatformIcon platform={p} colored={!!targets[p]?.enabled} />
                    {PLATFORM_LABEL[p]}
                    {targets[p]?.enabled && <CheckCircle2 className="size-3" />}
                  </button>
                ))}
              </div>
            </div>

            {/* per-target cards */}
            {enabledPlatforms.length === 0 && (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                {tr("social.pickPlatformHint", {
                  defaultValue:
                    "Pick a platform above — each one gets its own account, format, caption and schedule.",
                })}
              </div>
            )}
            {enabledPlatforms.map((p) => {
              const t = targets[p]!;
              const platAccounts = accounts.filter(
                (a) => a.platform === p && a.status === "active",
              );
              const cap = capabilities.find((c) => c.platform === p);
              const lim = limitsOf(p);
              const effTitle = t.title?.trim() ? t.title : title;
              const effCaption = t.caption?.trim() ? t.caption : caption;
              const overrideTags = parseTags(t.hashtagsRaw ?? "");
              const effTagCount = new Set(
                [
                  ...(overrideTags.length ? overrideTags : hashtags),
                  ...extractHashtags(effCaption),
                ].map((x) => x.toLowerCase()),
              ).size;
              return (
                <div
                  key={p}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold">
                      <PlatformIcon platform={p} />
                      {PLATFORM_LABEL[p]}
                    </span>
                    {cap?.requiresAppReview && (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                        {tr("social.needsApp")}
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
                        {tr("social.formatVersion")}
                      </span>
                      <VersionSelect
                        projectId={projectId}
                        value={t.versionId ?? ""}
                        onChange={(v) => setT(p, { versionId: v || null })}
                      />
                    </label>
                  </div>
                  <label className="block space-y-0.5 text-xs">
                    <span className="flex items-center justify-between text-muted-foreground">
                      {tr("social.titleOverride")}
                      <Counter n={effTitle.length} max={lim.titleMaxChars} />
                    </span>
                    <input
                      value={t.title ?? ""}
                      onChange={(e) => setT(p, { title: e.target.value })}
                      placeholder={title || tr("social.cs_title")}
                      className="h-7 w-full rounded border border-input bg-background px-2"
                    />
                  </label>
                  <label className="block space-y-0.5 text-xs">
                    <span className="flex items-center justify-between text-muted-foreground">
                      {tr("social.captionOverride")}
                      <Counter n={effCaption.length} max={lim.captionMaxChars} />
                    </span>
                    <textarea
                      value={t.caption ?? ""}
                      onChange={(e) => setT(p, { caption: e.target.value })}
                      placeholder={caption}
                      rows={2}
                      className="w-full resize-none rounded border border-input bg-background px-2 py-1"
                    />
                  </label>
                  <label className="block space-y-0.5 text-xs">
                    <span className="flex items-center justify-between text-muted-foreground">
                      {tr("social.hashtagsOverride")}
                      <Counter n={effTagCount} max={lim.hashtagMax} />
                    </span>
                    <input
                      value={t.hashtagsRaw ?? ""}
                      onChange={(e) => setT(p, { hashtagsRaw: e.target.value })}
                      placeholder={hashtags.map((h) => `#${h}`).join(" ")}
                      className="h-7 w-full rounded border border-input bg-background px-2"
                    />
                  </label>
                  <div className="flex items-end gap-2 text-xs">
                    <label className="flex-1 space-y-0.5">
                      <span className="text-muted-foreground">
                        {tr("social.scheduleLocal")}
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
                        {tr("social.autoPublish")}
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
                          {tr("social.privacyOpt", { v })}
                        </option>
                      ))}
                    </select>
                  )}
                  {cap && (
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      {tr(`social.note_${p}`, { defaultValue: cap.statusNote })}
                    </p>
                  )}
                </div>
              );
            })}

            {/* validation */}
            {savedId && (
              <ValidationPanel postId={savedId} key={savedId} onFix={onFix} />
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
            <X className="mr-1 size-3.5" /> {tr("common.close")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => void save(false)}
          >
            {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {tr("social.saveDraft")}
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save(true)}>
            {tr("social.markReady")}
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
