import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/ipc";
import { metricValue, type DashboardPost } from "@/lib/analytics-types";
import { MiniBar, SourceBadge } from "./charts";
import { PostStatsDetail } from "./PostStatsDetail";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const WINDOWS = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "12m" },
];
const PLATFORMS = ["all", "youtube", "tiktok", "instagram", "facebook"];

export function Dashboard() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [platform, setPlatform] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["analytics-dashboard", days, platform],
    queryFn: () =>
      api.analyticsDashboard(days, platform === "all" ? undefined : platform),
  });
  const posts = useMemo(() => q.data?.posts ?? [], [q.data]);

  // Per-platform totals — never cross-bucketed: each platform's numbers
  // stay in its own column because a "view" means different things.
  const byPlatform = useMemo(() => {
    const m = new Map<string, { views: number; likes: number; comments: number; shares: number; n: number }>();
    for (const p of posts) {
      const e = m.get(p.platform) ?? { views: 0, likes: 0, comments: 0, shares: 0, n: 0 };
      e.views += metricValue(p.metrics, "views") ?? 0;
      e.likes += metricValue(p.metrics, "likes") ?? 0;
      e.comments += metricValue(p.metrics, "comments") ?? 0;
      e.shares += metricValue(p.metrics, "shares") ?? 0;
      e.n += 1;
      m.set(p.platform, e);
    }
    return [...m.entries()];
  }, [posts]);

  const ranked = useMemo(
    () =>
      [...posts].sort(
        (a, b) => (metricValue(b.metrics, "views") ?? -1) - (metricValue(a.metrics, "views") ?? -1),
      ),
    [posts],
  );
  const top = ranked.slice(0, 3);
  const bottom = [...ranked].reverse().slice(0, 3);

  if (selected) {
    return (
      <PostStatsDetail targetId={selected} onBack={() => setSelected(null)} />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              className={cn(
                "px-2.5 py-1 text-xs rounded",
                days === w.days ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                "px-2.5 py-1 text-xs rounded capitalize",
                platform === p ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>
        {q.isFetching && <span className="text-xs text-muted-foreground">{t("ana.syncingView")}</span>}
      </div>

      {posts.length === 0 && !q.isFetching && (
        <EmptyState
          icon={BarChart3}
          title={t("ana.noStatsTitle")}
          body={t("ana.noStatsBody")}
        />
      )}

      {byPlatform.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${byPlatform.length}, 1fr)` }}>
          {byPlatform.map(([plat, s]) => (
            <div key={plat} className="rounded-xl border border-border bg-card p-3 shadow-raise">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold capitalize">{plat}</span>
                <span className="text-[10px] text-muted-foreground">{s.n} post{s.n === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-1.5 text-lg font-semibold leading-none">{fmt(s.views)}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("ana.col_views")}</div>
              <div className="mt-2 grid grid-cols-3 gap-1 border-t border-border/60 pt-1.5 text-[11px]">
                <span className="text-muted-foreground">Likes <b className="text-foreground">{fmt(s.likes)}</b></span>
                <span className="text-muted-foreground">Com. <b className="text-foreground">{fmt(s.comments)}</b></span>
                <span className="text-muted-foreground">Shares <b className="text-foreground">{fmt(s.shares)}</b></span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <RankCard title={t("ana.topPosts")} posts={top} onOpen={setSelected} />
        <RankCard title={t("ana.lowestPerforming")} posts={bottom} onOpen={setSelected} />
      </div>

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          Recent publications ({posts.length})
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left">{t("ana.col_post")}</th>
              <th className="px-2 py-1.5 text-left">{t("ana.col_platform")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.col_views")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.col_likes")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.col_comments")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.col_shares")}</th>
              <th className="px-2 py-1.5 text-left">{t("ana.col_source")}</th>
              <th className="px-2 py-1.5 text-left">{t("ana.col_synced")}</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr
                key={p.targetId}
                className="border-b border-border/50 hover:bg-muted/40 cursor-pointer"
                onClick={() => setSelected(p.targetId)}
              >
                <td className="px-3 py-1.5 max-w-[260px] truncate">{p.title}</td>
                <td className="px-2 py-1.5 capitalize">{p.platform}</td>
                <td className="px-2 py-1.5 text-right">{num(metricValue(p.metrics, "views"))}</td>
                <td className="px-2 py-1.5 text-right">{num(metricValue(p.metrics, "likes"))}</td>
                <td className="px-2 py-1.5 text-right">{num(metricValue(p.metrics, "comments"))}</td>
                <td className="px-2 py-1.5 text-right">{num(metricValue(p.metrics, "shares"))}</td>
                <td className="px-2 py-1.5"><SourceBadge source={p.source} /></td>
                <td className="px-2 py-1.5 text-muted-foreground">{p.fetchedAt.slice(0, 16)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RankCard({
  title,
  posts,
  onOpen,
}: {
  title: string;
  posts: DashboardPost[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border px-3 py-2 text-xs font-medium">{title}</div>
      <div className="divide-y divide-border/50">
        {posts.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">{t("ana.noData")}</div>
        )}
        {posts.map((p) => (
          <button
            key={p.targetId}
            className="flex w-full items-center justify-between px-3 py-2 text-xs hover:bg-muted/40"
            onClick={() => onOpen(p.targetId)}
          >
            <span className="truncate max-w-[220px]">{p.title}</span>
            <span className="flex items-center gap-2">
              <MiniBar
                values={[metricValue(p.metrics, "views") ?? 0]}
                width={40}
                height={18}
              />
              <b>{num(metricValue(p.metrics, "views"))}</b>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function num(v: number | null): string {
  return v === null ? "—" : fmt(v);
}
export function fmt(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}
