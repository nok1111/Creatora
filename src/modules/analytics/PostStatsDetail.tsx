import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { api } from "@/lib/ipc";
import { metricValue } from "@/lib/analytics-types";
import { MiniLine, SourceBadge } from "./charts";
import { Button } from "@/components/ui/button";
import { awaitJob } from "@/services/jobs";
import { toast } from "sonner";
import { num } from "./Dashboard";

const METRIC_ORDER = [
  "views", "impressions", "reach", "likes", "comments",
  "shares", "saves", "watch_time_minutes", "avg_view_duration_sec",
  "followers_gained",
];

export function PostStatsDetail({
  targetId,
  onBack,
}: {
  targetId: string;
  onBack: () => void;
}) {
  const hist = useQuery({
    queryKey: ["analytics-history", targetId],
    queryFn: () => api.analyticsTargetHistory(targetId),
  });
  const sync = () => {
    void api.analyticsSync(targetId).then(async (job) => {
      toast.info("Sync started");
      const f = await awaitJob(job);
      if (f.status === "done") {
        toast.success("Stats synced");
      } else {
        toast.error(`Sync failed: ${f.error ?? "unknown"}`);
      }
      void hist.refetch();
    });
  };

  const latest = hist.data?.[hist.data.length - 1];
  const metrics = latest?.metrics.metrics ?? [];
  const unavailable = latest?.metrics.unavailable ?? [];
  const series = (key: string) =>
    (hist.data ?? [])
      .map((s) => metricValue(s.metrics, key))
      .filter((v): v is number => v !== null);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1" /> Back
        </Button>
        <h2 className="text-sm font-semibold">
          Post performance · <span className="capitalize">{latest?.platform}</span>
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {latest && <SourceBadge source={latest.source} />}
          <Button size="sm" variant="secondary" onClick={sync}>
            <RefreshCw size={13} className="mr-1" /> Sync now
          </Button>
        </div>
      </div>

      {latest && (
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-border p-3 space-y-1 text-xs">
            <div><span className="text-muted-foreground">Remote id:</span> {latest.remoteId ?? "—"}</div>
            <div><span className="text-muted-foreground">Period:</span> {latest.period}</div>
            <div><span className="text-muted-foreground">Last sync:</span> {latest.fetchedAt}</div>
            <div><span className="text-muted-foreground">Snapshots:</span> {hist.data?.length ?? 0}</div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-xs font-medium">Views over time</div>
            <MiniLine points={series("views")} width={280} height={64} />
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-medium">Metrics (latest)</div>
        <table className="w-full text-xs">
          <tbody>
            {METRIC_ORDER.map((key) => {
              const m = metrics.find((x) => x.key === key);
              const un = unavailable.find((u) => u.key === key);
              if (!m && !un) return null;
              return (
                <tr key={key} className="border-b border-border/50">
                  <td className="px-3 py-1.5">{m?.label ?? key}</td>
                  <td className="px-3 py-1.5 text-right">
                    {m ? num(m.value) : (
                      <span className="text-muted-foreground" title={un?.reason}>
                        n/a — {un?.reason}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{m?.unit}</td>
                </tr>
              );
            })}
            {metrics
              .filter((m) => !METRIC_ORDER.includes(m.key))
              .map((m) => (
                <tr key={m.key} className="border-b border-border/50">
                  <td className="px-3 py-1.5">{m.label}</td>
                  <td className="px-3 py-1.5 text-right">{num(m.value)}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{m.unit}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {(hist.data?.length ?? 0) > 1 && (
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-medium">History</div>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left">Fetched</th>
                <th className="text-left">Source</th>
                <th className="text-right">Views</th>
                <th className="text-right">Likes</th>
                <th className="text-right">Comments</th>
              </tr>
            </thead>
            <tbody>
              {[...(hist.data ?? [])].reverse().map((s) => (
                <tr key={s.id} className="border-t border-border/50">
                  <td className="py-1">{s.fetchedAt}</td>
                  <td className="py-1"><SourceBadge source={s.source} /></td>
                  <td className="py-1 text-right">{num(metricValue(s.metrics, "views"))}</td>
                  <td className="py-1 text-right">{num(metricValue(s.metrics, "likes"))}</td>
                  <td className="py-1 text-right">{num(metricValue(s.metrics, "comments"))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
