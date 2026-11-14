import { X, Lightbulb } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { useSuggestions, type ProjectSignals } from "@/services/suggestions";
import type { ProjectDoc } from "@/lib/project-types";

/**
 * Contextual next-step strip — renders at most one slim, dismissable
 * suggestion inside a page (not a popup). Driven entirely by the
 * centralized evaluator in services/suggestions.ts.
 */
export function SuggestionBanner({ doc }: { doc: ProjectDoc | null }) {
  const nav = useNavigate();
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
      }
    : null;

  const { suggestions, dismiss } = useSuggestions(signals, (posts.data?.length ?? 0) > 0);
  const s = suggestions[0];
  if (!s) return null;

  return (
    <div className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs">
      <Lightbulb className="size-3.5 shrink-0 text-warning" />
      <span className="truncate">
        <b className="mr-1.5">{s.title}:</b>
        {s.body}
      </span>
      <button
        className="shrink-0 font-medium text-primary hover:underline"
        onClick={() => nav(s.to)}
      >
        {s.actionLabel}
      </button>
      <button
        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => dismiss(s.key)}
        title="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
