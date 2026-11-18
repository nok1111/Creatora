import { X, Lightbulb } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/ipc";
import { Notice } from "@/components/Notice";
import { useProject } from "@/stores/project";
import { useSuggestions, type ProjectSignals } from "@/services/suggestions";
import type { ProjectDoc } from "@/lib/project-types";

/**
 * Contextual next-step strip — renders at most one slim, dismissable
 * suggestion inside a page (not a popup). Driven entirely by the
 * centralized evaluator in services/suggestions.ts.
 * `only` restricts which suggestion keys may surface on this page.
 */
export function SuggestionBanner({
  doc,
  only,
}: {
  doc: ProjectDoc | null;
  only?: string[];
}) {
  const nav = useNavigate();
  const { t } = useTranslation();
  const filePath = useProject((s) => s.filePath);
  const posts = useQuery({
    queryKey: ["social-posts-count"],
    queryFn: () => api.listSocialPosts(),
    staleTime: 30_000,
  });

  const signals: ProjectSignals | null = doc
    ? {
        versions: doc.versions.map((v) => ({
          aspectRatio:
            v.canvas.height > v.canvas.width
              ? "9:16"
              : v.canvas.width > v.canvas.height
                ? "16:9"
                : "1:1",
        })),
        hasSubtitles: doc.subtitles.length > 0,
        subtitleStyleApplied: doc.subtitles.some((c) => c.styleId != null),
        hasThumbnail: doc.mediaRefs.some((r) => /\.(png|jpe?g|webp|bmp)$/i.test(r.path)),
        hasMedia: doc.mediaRefs.length > 0,
        hasClips: doc.timeline.tracks.some((tr) => tr.clips.length > 0),
        projectPath: filePath,
      }
    : null;

  const { suggestions, dismiss } = useSuggestions(
    signals,
    (posts.data?.length ?? 0) > 0,
    only,
  );
  const s = suggestions[0];
  if (!s) return null;

  return (
    <Notice tone="warning" icon={Lightbulb}>
      <span className="truncate">
        <b className="mr-1.5">{t(s.title)}:</b>
        {t(s.body)}
      </span>
      <button
        className="shrink-0 font-medium text-primary hover:underline"
        onClick={() => nav(s.to)}
      >
        {t(s.actionLabel)}
      </button>
      <button
        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => dismiss(s.key)}
        title={t("common.dismiss", { defaultValue: "Dismiss" })}
      >
        <X className="size-3.5" />
      </button>
    </Notice>
  );
}
