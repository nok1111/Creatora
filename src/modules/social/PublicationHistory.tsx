import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Clock, Ban, ExternalLink } from "lucide-react";
import { api, type PublicationHistoryRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PLATFORM_LABEL } from "@/lib/social-types";

const PLATFORMS = ["youtube", "tiktok", "instagram", "facebook"];
const OUTCOMES = [
  { key: "", label: "All" },
  { key: "ok", label: "Published" },
  { key: "failed", label: "Failed" },
  { key: "uploading", label: "In progress" },
  { key: "cancelled", label: "Cancelled" },
];

const STATUS_ICON: Record<string, React.ReactNode> = {
  published: <CheckCircle2 className="size-3.5 text-success" />,
  failed: <XCircle className="size-3.5 text-destructive" />,
  uploading: <Clock className="size-3.5 text-primary" />,
  cancelled: <Ban className="size-3.5 text-warning" />,
};

export function PublicationHistory({ onOpenPost }: { onOpenPost: (postId: string) => void }) {
  const [platform, setPlatform] = useState("");
  const [outcome, setOutcome] = useState("");
  const [since, setSince] = useState("");

  const rows = useQuery({
    queryKey: ["publication-history", platform, outcome, since],
    queryFn: () =>
      api.publicationHistory({
        platform: platform || undefined,
        outcome: outcome || undefined,
        since: since || undefined,
        limit: 300,
      }),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-xs">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1"
        >
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p as keyof typeof PLATFORM_LABEL] ?? p}
            </option>
          ))}
        </select>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {OUTCOMES.map((o) => (
            <button
              key={o.key}
              onClick={() => setOutcome(o.key)}
              className={cn(
                "rounded-md px-2.5 py-0.5",
                outcome === o.key ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-muted-foreground"
          title="Attempts since"
        />
        <span className="ml-auto text-muted-foreground">{rows.data?.length ?? 0} attempts</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-5 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Post</th>
              <th className="px-3 py-2 text-left">Platform</th>
              <th className="px-3 py-2 text-left">Started</th>
              <th className="px-3 py-2 text-left">Finished</th>
              <th className="px-3 py-2 text-left">Remote ID / error</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {(rows.data ?? []).map((r: PublicationHistoryRow) => (
              <tr key={r.attemptId} className="border-b border-border/50">
                <td className="px-5 py-2">
                  <span className="flex items-center gap-1.5 text-xs capitalize">
                    {STATUS_ICON[r.status] ?? <Clock className="size-3.5" />}
                    {r.status}
                  </span>
                </td>
                <td className="max-w-[220px] px-3 py-2">
                  <button
                    className="truncate text-left font-medium hover:underline"
                    onClick={() => onOpenPost(r.postId)}
                    title={r.postTitle}
                  >
                    {r.postTitle || "(untitled)"}
                  </button>
                </td>
                <td className="px-3 py-2 text-xs">{PLATFORM_LABEL[r.platform as keyof typeof PLATFORM_LABEL] ?? r.platform}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.startedAt}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.finishedAt ?? "—"}</td>
                <td className="max-w-[280px] px-3 py-2">
                  {r.status === "published" && r.platformPostId && (
                    <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                      {r.platformUrl ? (
                        <a
                          href={r.platformUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 hover:underline"
                        >
                          {r.platformPostId} <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        r.platformPostId
                      )}
                    </span>
                  )}
                  {r.error && (
                    <span className="line-clamp-2 text-[10px] text-destructive" title={r.error}>
                      {r.error}
                    </span>
                  )}
                </td>
                <td className="px-5 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => onOpenPost(r.postId)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
            {(rows.data ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted-foreground">
                  No publication attempts match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
