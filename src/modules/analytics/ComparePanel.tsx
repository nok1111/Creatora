import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { METRIC_LABEL } from "@/lib/analytics-types";
import { MiniBar, SourceBadge } from "./charts";
import { Button } from "@/components/ui/button";
import { num } from "./Dashboard";
import { useTranslation } from "react-i18next";

const SORTABLE = [
  "views", "likes", "comments", "shares", "saves",
  "watch_time_minutes", "avg_view_duration_sec", "impressions", "reach",
];

export function ComparePanel() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState("views");
  const pool = useQuery({
    queryKey: ["analytics-dashboard", 365, "all"],
    queryFn: () => api.analyticsDashboard(365),
  });
  const posts = useMemo(() => pool.data?.posts ?? [], [pool.data]);

  const cmp = useQuery({
    queryKey: ["analytics-compare", [...selected].sort()],
    queryFn: () => api.analyticsCompare([...selected]),
    enabled: selected.size >= 2,
  });

  const rows = useMemo(() => {
    const r = [...(cmp.data?.rows ?? [])];
    r.sort((a, b) => (b.metrics[sortKey] ?? -1) - (a.metrics[sortKey] ?? -1));
    return r;
  }, [cmp.data, sortKey]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < 20) n.add(id);
      return n;
    });

  const samePlatform =
    rows.length > 0 &&
    new Set(rows.map((r) => r.platform).filter(Boolean)).size === 1;

  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        Select 2–20 published posts to compare. Metrics shown are only those
        the platforms actually served — missing values are “—”, never 0.
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-medium">
            Published posts ({posts.length})
          </div>
          <div className="max-h-[480px] overflow-y-auto">
            {posts.map((p) => (
              <label
                key={p.targetId}
                className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.targetId)}
                  onChange={() => toggle(p.targetId)}
                />
                <span className="truncate">{p.title}</span>
                <span className="ml-auto capitalize text-muted-foreground">
                  {p.platform}
                </span>
              </label>
            ))}
            {posts.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted-foreground">
                No posts with stats yet.
              </div>
            )}
          </div>
        </div>

        <div className="col-span-2 rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium">{t("ana.comparison")}</span>
            {rows.length > 0 && !samePlatform && (
              <span className="rounded bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                Mixed platforms — metrics are not equivalent; compare within one platform for meaning.
              </span>
            )}
            <div className="ml-auto flex items-center gap-1 text-xs">
              sort by
              <select
                className="rounded border border-border bg-background px-1.5 py-0.5"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
              >
                {SORTABLE.map((k) => (
                  <option key={k} value={k}>{METRIC_LABEL[k] ?? k}</option>
                ))}
              </select>
            </div>
          </div>
          {!cmp.data && (
            <div className="px-3 py-8 text-xs text-muted-foreground">
              Pick at least two posts.
            </div>
          )}
          {cmp.data && (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-1.5 text-left">{t("ana.col_post")}</th>
                  <th className="px-2 py-1.5 text-left">{t("ana.col_platform")}</th>
                  <th className="px-2 py-1.5 text-left">{t("ana.col_source")}</th>
                  {cmp.data.metricKeys.map((k) => (
                    <th key={k} className="px-2 py-1.5 text-right">
                      {METRIC_LABEL[k] ?? k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.targetId} className="border-b border-border/50">
                    <td className="max-w-[200px] truncate px-3 py-1.5">
                      {r.title ?? r.targetId.slice(0, 8)}
                    </td>
                    <td className="px-2 py-1.5 capitalize">{r.platform ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      {r.source ? <SourceBadge source={r.source} /> : "—"}
                    </td>
                    {cmp.data.metricKeys.map((k) => (
                      <td key={k} className="px-2 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {r.metrics[k] !== undefined && (
                            <MiniBar values={[r.metrics[k]]} width={34} height={14} />
                          )}
                          {r.noData
                            ? <span className="text-muted-foreground">{t("ana.noData")}</span>
                            : num(r.metrics[k] ?? null)}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          disabled={selected.size === 0}
          onClick={() => setSelected(new Set())}
        >
          Clear selection
        </Button>
      </div>
    </div>
  );
}
