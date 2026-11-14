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

export function evalSuggestions(ctx: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = [];
  if (ctx.exportedHorizontal && !ctx.hasVerticalVersion) {
    out.push({
      key: "adapt-vertical",
      title: "Go vertical",
      body: "Turn this export into a vertical video for Reels and Shorts.",
      actionLabel: "Add vertical version",
      to: "/editor",
    });
  }
  if (ctx.hasSubtitles && !ctx.subtitleStyleApplied) {
    out.push({
      key: "subtitle-style",
      title: "Style your captions",
      body: "Try a subtitle style to make your captions stand out.",
      actionLabel: "Open Subtitle Studio",
      to: "/editor?tab=subtitles",
    });
  }
  if (ctx.hasThumbnail && !ctx.postUsesThumbnail) {
    out.push({
      key: "thumbnail-to-post",
      title: "Put your thumbnail to work",
      body: "Add this thumbnail to a YouTube publication post.",
      actionLabel: "Open Social Studio",
      to: "/social",
    });
  }
  if (ctx.multiFormat && !ctx.hasSocialPost) {
    out.push({
      key: "prepare-publish",
      title: "Ready to publish",
      body: "You have multiple formats — prepare your content for publication.",
      actionLabel: "Plan a post",
      to: "/social",
    });
  }
  return out.slice(0, 2);
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
}

export function useSuggestions(project: ProjectSignals | null, hasSocialPost: boolean): {
  suggestions: Suggestion[];
  dismiss: (key: string) => void;
} {
  // Re-render when a dismissal happens.
  useSyncExternalStore(subscribe, () => DISMISS_KEY);

  const jobs = useQuery({
    queryKey: ["jobs", "suggestions"],
    queryFn: () => api.listJobs("export", 20),
    staleTime: 15_000,
  });

  const dismissed = dismissedKeys();

  const suggestions = useMemo(() => {
    const recentExport = (jobs.data ?? []).find(
      (j: JobRow) => j.kind.includes("export") && j.status === "done" && j.payload?.outputPath,
    );
    const vertical = project?.versions.some((v) => v.aspectRatio === "9:16") ?? false;
    const ctx: SuggestionContext = {
      exportedHorizontal: Boolean(recentExport) && !vertical,
      hasVerticalVersion: vertical,
      hasSubtitles: project?.hasSubtitles ?? false,
      subtitleStyleApplied: project?.subtitleStyleApplied ?? false,
      hasThumbnail: project?.hasThumbnail ?? false,
      postUsesThumbnail: hasSocialPost,
      multiFormat: (project?.versions.length ?? 0) >= 2,
      hasSocialPost,
    };
    return evalSuggestions(ctx).filter((s) => !dismissed.has(s.key));
  }, [jobs.data, project, hasSocialPost, dismissed]);

  return { suggestions, dismiss: dismissSuggestion };
}
