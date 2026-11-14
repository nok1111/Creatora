import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { api, type AccountSnapshot } from "@/lib/ipc";
import { METRIC_LABEL, metricValue, type DashboardPost } from "@/lib/analytics-types";
import { MiniLine, SourceBadge } from "./charts";
import { PostStatsDetail } from "./PostStatsDetail";
import { cn } from "@/lib/utils";
import { num } from "./Dashboard";
import { useTranslation } from "react-i18next";

const PLATFORMS = ["youtube", "tiktok", "instagram", "facebook"] as const;
const PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
};
const WINDOWS = [7, 28, 90];

const ACCOUNT_LABEL: Record<string, string> = {
  subscriber_count: "ana.m_subscribers",
  follower_count: "ana.m_followers",
  following_count: "ana.m_following",
  media_count: "ana.m_posts",
  video_count: "ana.m_videos",
};

export function PlatformView() {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<string>("youtube");
  const [days, setDays] = useState(28);
  const [detail, setDetail] = useState<string | null>(null);

  const dash = useQuery({
    queryKey: ["platform-view", platform, days],
    queryFn: () => api.analyticsDashboard(days, platform),
  });
  const account = useQuery({
    queryKey: ["account-history", platform],
    queryFn: () => api.analyticsAccountHistory(platform),
  });
  const caps = useQuery({
    queryKey: ["analytics-stats-info"],
    queryFn: () => api.analyticsPlatformStatsInfo(),
  });

  if (detail) return <PostStatsDetail targetId={detail} onBack={() => setDetail(null)} />;

  const posts = (dash.data?.posts ?? [])
    .slice()
    .sort((a, b) => (metricValue(b.metrics, "views") ?? -1) - (metricValue(a.metrics, "views") ?? -1));

  // Latest snapshot per account; trend for the first numeric metric.
  const snaps: AccountSnapshot[] = account.data?.rows ?? [];
  const acctKeys = new Set(snaps.flatMap((s) => s.metrics.map((m) => m.key)));
  const trendKey = snaps.find((s) => s.metrics.length > 0)?.metrics[0]?.key;
  const trend = snaps
    .filter((s) => s.metrics.some((m) => m.key === trendKey))
    .map((s) => ({
      at: s.fetchedAt.slice(0, 10),
      v: s.metrics.find((m) => m.key === trendKey)!.value,
    }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                "rounded-md px-3 py-1 text-xs",
                platform === p ? "bg-secondary font-medium" : "text-muted-foreground",
              )}
            >
              {PLATFORM_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                days === w ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {/* Account-level metrics — only real snapshots, never derived */}
      <div className="rounded-lg border border-border p-4">
        <div className="text-sm font-medium">Account metrics — {PLATFORM_LABELS[platform]}</div>
        {snaps.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            No account snapshots yet. They are captured automatically during sync
            when the platform API supports account-level metrics.
          </p>
        )}
        {snaps.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-4">
            {[...acctKeys].map((k) => {
              const latest = [...snaps]
                .reverse()
                .find((s) => s.metrics.some((m) => m.key === k));
              const m = latest?.metrics.find((x) => x.key === k);
              if (!m) return null;
              return (
                <div key={k} className="min-w-[110px]">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {ACCOUNT_LABEL[k] ? t(ACCOUNT_LABEL[k]) : m.label}
                  </div>
                  <div className="text-lg font-semibold">{num(m.value)}</div>
                  <SourceBadge source={latest!.source} />
                </div>
              );
            })}
          </div>
        )}
        {trend.length >= 2 && trendKey && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {ACCOUNT_LABEL[trendKey] ? t(ACCOUNT_LABEL[trendKey]) : trendKey}
            </div>
            <MiniLine points={trend.map((t) => t.v)} />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{trend[0].at}</span>
              <span>{trend[trend.length - 1].at}</span>
            </div>
          </div>
        )}
        {trend.length === 1 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Only one snapshot — history chart appears after the next sync.
          </p>
        )}
      </div>

      {/* Platform capability note */}
      {caps.data && (
        <p className="text-[11px] text-muted-foreground">
          {caps.data[platform as keyof typeof caps.data]}
        </p>
      )}

      {/* Top posts */}
      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-4 py-2 text-xs font-medium">
          Top posts — last {days} days
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left">{t("ana.col_post")}</th>
              <th className="px-3 py-2 text-right">{t("ana.col_views")}</th>
              <th className="px-3 py-2 text-right">{t("ana.col_likes")}</th>
              <th className="px-3 py-2 text-right">{t("ana.col_comments")}</th>
              <th className="px-3 py-2 text-left">{t("ana.col_source")}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {posts.slice(0, 20).map((p: DashboardPost) => (
              <tr key={p.targetId} className="border-b border-border/50">
                <td className="max-w-[300px] truncate px-4 py-2 font-medium">{p.title}</td>
                <td className="px-3 py-2 text-right">
                  {metricValue(p.metrics, "views") != null ? num(metricValue(p.metrics, "views")!) : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  {metricValue(p.metrics, "likes") != null ? num(metricValue(p.metrics, "likes")!) : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  {metricValue(p.metrics, "comments") != null
                    ? num(metricValue(p.metrics, "comments")!)
                    : "—"}
                </td>
                <td className="px-3 py-2"><SourceBadge source={p.source} /></td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={() => setDetail(p.targetId)}
                  >
                    Detail <ArrowUpRight className="inline size-3" />
                  </button>
                </td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No {PLATFORM_LABELS[platform]} posts with metrics yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {posts.some((p) => p.metrics.unavailable.length > 0) && (
        <div className="rounded-lg border border-border p-3 text-[11px] text-muted-foreground">
          <b>{t("ana.unavailable")}</b>{" "}
          {[...new Set(posts.flatMap((p) => p.metrics.unavailable.map((u) => METRIC_LABEL[u.key] ?? u.key)))].join(", ")}{" "}
          — see each post for the reason.
        </div>
      )}
    </div>
  );
}
