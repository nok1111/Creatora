import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import type { JobRow } from "@/lib/ipc";

/**
 * Contextual next-step suggestions.
 *
 * A single pure evaluator reads real product state (recent jobs, the
 * current project document, social posts) and emits at most a few
 * suggestions. Nothing is hardcoded per-component; dismissing is
 * persisted in localStorage and a suggestion that was already done
 * (e.g. vertical version exists) is never shown again.
 */

export interface Suggestion {
  /** Stable key — used for dedupe + dismissal. */
  key: string;
  title: string;
  body: string;
  actionLabel: string;
  /** Router path to navigate to. */
  to: string;
}

export interface SuggestionContext {
  /** Project has imported media references. */
  hasMedia: boolean;
  /** Timeline has at least one clip. */
  hasClips: boolean;
  /** A completed export exists for this project. */
  exportedAny: boolean;
  /** A horizontal export finished recently and no vertical version exists. */
  exportedHorizontal: boolean;
  hasVerticalVersion: boolean;
  /** Subtitles exist but no style has been applied. */
  hasSubtitles: boolean;
  subtitleStyleApplied: boolean;
  /** A thumbnail/graphic asset exists but no post uses a thumbnail. */
  hasThumbnail: boolean;
  postUsesThumbnail: boolean;
  /** Two or more export versions exist but no social post is linked. */
  multiFormat: boolean;
  hasSocialPost: boolean;
}

export function evalSuggestions(
  ctx: SuggestionContext,
  only?: string[],
): Suggestion[] {
  const out: Suggestion[] = [];
  // Workflow order — earliest unmet stage wins first slot.
  if (!ctx.hasMedia) {
    out.push({
      key: "import-media",
      title: "suggest.importMedia.title",
      body: "suggest.importMedia.body",
      actionLabel: "suggest.importMedia.action",
      to: "/library",
    });
  } else if (!ctx.hasClips) {
    out.push({
      key: "add-to-timeline",
      title: "suggest.addToTimeline.title",
      body: "suggest.addToTimeline.body",
      actionLabel: "suggest.addToTimeline.action",
      to: "/editor",
    });
  } else {
    if (!ctx.hasSubtitles) {
      out.push({
        key: "create-subtitles",
        title: "suggest.createSubtitles.title",
        body: "suggest.createSubtitles.body",
        actionLabel: "suggest.createSubtitles.action",
        to: "/editor?tab=subtitles",
      });
    }
    if (!ctx.exportedAny) {
      out.push({
        key: "export-video",
        title: "suggest.exportVideo.title",
        body: "suggest.exportVideo.body",
        actionLabel: "suggest.exportVideo.action",
        to: "/editor?export=1",
      });
    }
  }
  if (ctx.exportedHorizontal && !ctx.hasVerticalVersion) {
    out.push({
      key: "adapt-vertical",
      title: "suggest.adaptVertical.title",
      body: "suggest.adaptVertical.body",
      actionLabel: "suggest.adaptVertical.action",
      to: "/editor",
    });
  }
  if (ctx.hasSubtitles && !ctx.subtitleStyleApplied) {
    out.push({
      key: "subtitle-style",
      title: "suggest.subtitleStyle.title",
      body: "suggest.subtitleStyle.body",
      actionLabel: "suggest.subtitleStyle.action",
      to: "/editor?tab=subtitles",
    });
  }
  if (ctx.hasThumbnail && !ctx.postUsesThumbnail) {
    out.push({
      key: "thumbnail-to-post",
      title: "suggest.thumbnailToPost.title",
      body: "suggest.thumbnailToPost.body",
      actionLabel: "suggest.thumbnailToPost.action",
      to: "/social",
    });
  }
  if ((ctx.multiFormat || ctx.exportedAny) && !ctx.hasSocialPost) {
    out.push({
      key: "prepare-publish",
      title: "suggest.preparePublish.title",
      body: "suggest.preparePublish.body",
      actionLabel: "suggest.preparePublish.action",
      to: "/social",
    });
  }
  // Page scoping happens before the cap so a page's relevant suggestion
  // is never pushed out by workflow stages it doesn't display.
  return out.filter((s) => !only || only.includes(s.key)).slice(0, 2);
}

// ---------- dismissal persistence ----------

const DISMISS_KEY = "creatora.suggestions.dismissed";
const listeners = new Set<() => void>();

export function dismissedKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function dismissSuggestion(key: string) {
  const d = dismissedKeys();
  d.add(key);
  localStorage.setItem(DISMISS_KEY, JSON.stringify([...d]));
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ---------- hook: gathers real state, evaluates ----------

export interface ProjectSignals {
  versions: { aspectRatio?: string }[];
  hasSubtitles: boolean;
  subtitleStyleApplied: boolean;
  hasThumbnail: boolean;
  hasMedia: boolean;
  hasClips: boolean;
  /** Current project file — scopes "exported" signals to this project. */
  projectPath?: string | null;
}

export function useSuggestions(
  project: ProjectSignals | null,
  hasSocialPost: boolean,
  only?: string[],
): {
  suggestions: Suggestion[];
  dismiss: (key: string) => void;
} {
  // Re-render when a dismissal happens.
  useSyncExternalStore(subscribe, () => DISMISS_KEY);

  const jobs = useQuery({
    queryKey: ["jobs", "suggestions"],
    // No kind prefix — job kinds are "render.export" etc., filtered below.
    queryFn: () => api.listJobs(undefined, 30),
    staleTime: 15_000,
  });

  const dismissed = dismissedKeys();

  const suggestions = useMemo(() => {
    const doneExports = (jobs.data ?? []).filter(
      (j: JobRow) => j.kind.includes("export") && j.status === "done" && j.payload?.outputPath,
    );
    const mine = project?.projectPath
      ? doneExports.filter((j) => j.payload?.projectPath === project.projectPath)
      : [];
    const exportedAny = project
      ? project.projectPath
        ? mine.length > 0
        : doneExports.length > 0
      : false;
    // "Go vertical" needs a project in the editor to act on — don't offer
    // it from a project-less session even if someone else's export exists.
    const recentExport = project ? (mine[0] ?? doneExports[0]) : undefined;
    const vertical = project?.versions.some((v) => v.aspectRatio === "9:16") ?? false;
    const ctx: SuggestionContext = {
      hasMedia: project?.hasMedia ?? false,
      hasClips: project?.hasClips ?? false,
      exportedAny,
      exportedHorizontal: Boolean(recentExport) && !vertical,
      hasVerticalVersion: vertical,
      hasSubtitles: project?.hasSubtitles ?? false,
      subtitleStyleApplied: project?.subtitleStyleApplied ?? false,
      hasThumbnail: project?.hasThumbnail ?? false,
      postUsesThumbnail: hasSocialPost,
      multiFormat: (project?.versions.length ?? 0) >= 2,
      hasSocialPost,
    };
    return evalSuggestions(ctx, only).filter((s) => !dismissed.has(s.key));
  }, [jobs.data, project, hasSocialPost, dismissed, only]);

  return { suggestions, dismiss: dismissSuggestion };
}
