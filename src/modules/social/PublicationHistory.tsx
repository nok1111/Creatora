import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Clock, Ban, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type PublicationHistoryRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PLATFORM_LABEL, SOCIAL_PLATFORMS } from "@/lib/social-types";
import { PlatformIcon } from "./PlatformIcon";

const OUTCOME_KEYS = ["", "published", "failed", "uploading", "cancelled"];

const STATUS_ICON: Record<string, React.ReactNode> = {
  published: <CheckCircle2 className="size-3.5 text-success" />,
  failed: <XCircle className="size-3.5 text-destructive" />,
  uploading: <Clock className="size-3.5 text-primary" />,
  cancelled: <Ban className="size-3.5 text-warning" />,
};

export function PublicationHistory({ onOpenPost }: { onOpenPost: (postId: string) => void }) {
  const { t } = useTranslation();
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
          <option value="">{t("pubhist.allPlatforms")}</option>
          {SOCIAL_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p as keyof typeof PLATFORM_LABEL] ?? p}
            </option>
          ))}
        </select>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {OUTCOME_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setOutcome(k)}
              className={cn(
                "rounded-md px-2.5 py-0.5",
                outcome === k ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {t(`pubhist.out_${k || "all"}`)}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-muted-foreground"
          title={t("pubhist.attemptsSince")}
          aria-label={t("pubhist.attemptsSince")}
        />
        <span className="ml-auto text-muted-foreground">
          {t("pubhist.attempts", { count: rows.data?.length ?? 0 })}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-5 py-2 text-left">{t("pubhist.col_status")}</th>
              <th className="px-3 py-2 text-left">{t("pubhist.col_post")}</th>
              <th className="px-3 py-2 text-left">{t("pubhist.col_platform")}</th>
              <th className="px-3 py-2 text-left">{t("pubhist.col_started")}</th>
              <th className="px-3 py-2 text-left">{t("pubhist.col_finished")}</th>
              <th className="px-3 py-2 text-left">{t("pubhist.col_remote")}</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {(rows.data ?? []).map((r: PublicationHistoryRow) => (
              <tr key={r.attemptId} className="border-b border-border/50">
                <td className="px-5 py-2">
                  <span className="flex items-center gap-1.5 text-xs">
                    {STATUS_ICON[r.status] ?? <Clock className="size-3.5" />}
                    {t(`pubhist.st_${r.status}`, { defaultValue: r.status })}
                  </span>
                </td>
                <td className="max-w-[220px] px-3 py-2">
                  <button
                    className="truncate text-left font-medium hover:underline"
                    onClick={() => onOpenPost(r.postId)}
                    title={r.postTitle}
                  >
                    {r.postTitle || t("pubhist.untitled")}
                  </button>
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <PlatformIcon platform={r.platform} />
                    {PLATFORM_LABEL[r.platform as keyof typeof PLATFORM_LABEL] ?? r.platform}
                  </span>
                </td>
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
                    {t("pubhist.open")}
                  </Button>
                </td>
              </tr>
            ))}
            {(rows.data ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted-foreground">
                  {t("pubhist.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
