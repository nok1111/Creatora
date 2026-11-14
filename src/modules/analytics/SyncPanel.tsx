import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/ipc";
import { awaitJob } from "@/services/jobs";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

const INTERVALS = [
  { v: 0, label: "ana.sched_off" },
  { v: 60, label: "ana.sched_hourly" },
  { v: 360, label: "ana.sched_6h" },
  { v: 720, label: "ana.sched_12h" },
  { v: 1440, label: "ana.sched_daily" },
  { v: 10080, label: "ana.sched_weekly" },
];

export function SyncPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["analytics-sync-status"],
    queryFn: () => api.analyticsSyncStatus(),
  });
  const runs = useQuery({
    queryKey: ["analytics-sync-runs"],
    queryFn: () => api.analyticsSyncRuns(30),
  });
  const caps = useQuery({
    queryKey: ["analytics-stats-info"],
    queryFn: () => api.analyticsPlatformStatsInfo(),
  });
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const runNow = async () => {
    setBusy(true);
    try {
      const job = await api.analyticsSync();
      setJobId(job);
      const f = await awaitJob<{ ok: number; failed: number }>(job);
      if (f.status === "done") {
        toast.success(`Sync done: ${f.result?.ok ?? 0} ok, ${f.result?.failed ?? 0} failed`);
      } else if (f.status === "cancelled") {
        toast.info(t("ana.syncCancelled"));
      } else {
        toast.error(t("ana.failed"), { description: f.error ?? f.status });
      }
      void qc.invalidateQueries({ queryKey: ["analytics-sync-runs"] });
      void qc.invalidateQueries({ queryKey: ["analytics-dashboard"] });
    } finally {
      setBusy(false);
      setJobId(null);
    }
  };

  const cancel = async () => {
    if (!jobId) return;
    await api.cancelJob(jobId);
    toast.info(t("ana.cancelling"));
  };

  const setIntervalMin = async (v: number) => {
    await api.analyticsSetSyncInterval(v);
    toast.success(v === 0 ? t("ana.autoOff") : t("ana.autoEvery", { v }));
    void status.refetch();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="text-sm font-medium">{t("ana.synchronization")}</div>
          <div className="text-xs text-muted-foreground space-y-1">
            <div>{t("ana.syncableTargets")}<b>{status.data?.syncableTargets ?? 0}</b></div>
            <div>{t("ana.lastFinished")}<b>{status.data?.lastFinishedAt ?? "never"}</b></div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">{t("ana.autoSync")}</span>
            <select
              className="rounded border border-border bg-background px-2 py-1 text-xs"
              value={status.data?.intervalMinutes ?? 0}
              onChange={(e) => void setIntervalMin(Number(e.target.value))}
            >
              {INTERVALS.map((i) => (
                <option key={i.v} value={i.v}>{t(i.label)}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void runNow()}>
              <RefreshCw size={13} className="mr-1" />
              {busy ? t("ana.syncing") : t("ana.syncNow")}
            </Button>
            {busy && jobId && (
              <Button size="sm" variant="destructive" onClick={() => void cancel()}>
                <XCircle size={13} className="mr-1" /> Cancel
              </Button>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="text-sm font-medium">{t("ana.whatCanReport")}</div>
          <div className="space-y-2 text-[11px] text-muted-foreground">
            {Object.entries(caps.data ?? {}).map(([p, info]) => (
              <div key={p}>
                <span className="capitalize font-medium text-foreground">{p}:</span>{" "}
                {info}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          Sync runs
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left">{t("ana.col_started")}</th>
              <th className="px-2 py-1.5 text-left">{t("ana.col_trigger")}</th>
              <th className="px-2 py-1.5 text-left">{t("ana.col_status")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.ok")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.failed")}</th>
              <th className="px-3 py-1.5 text-left">{t("ana.errors")}</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id} className="border-b border-border/50 align-top">
                <td className="px-3 py-1.5">{r.startedAt}</td>
                <td className="px-2 py-1.5">{r.triggerKind}</td>
                <td className="px-2 py-1.5">{r.status}</td>
                <td className="px-2 py-1.5 text-right">{r.targetsOk}</td>
                <td className="px-2 py-1.5 text-right">{r.targetsFailed}</td>
                <td className="px-3 py-1.5 max-w-[380px]">
                  {r.errors.slice(0, 3).map((e, i) => (
                    <div key={i} className="truncate text-destructive/80">{e}</div>
                  ))}
                </td>
              </tr>
            ))}
            {(runs.data ?? []).length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                No syncs yet.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
