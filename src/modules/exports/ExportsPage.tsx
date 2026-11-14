import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, XCircle, RefreshCw, Rocket } from "lucide-react";
import { toast } from "sonner";
import { api, type JobRow } from "@/lib/ipc";
import { awaitJob, onJobFinished } from "@/services/jobs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<string, string> = {
  "render.export": "Export",
  "social.export": "Social export",
  "social.publish": "Publish",
  "media.import": "Import",
  "media.proxies": "Proxies",
  "reframe.analyze": "Reframe",
  "analytics.sync": "Stats sync",
};

const STATUS_TONE: Record<string, string> = {
  done: "text-success",
  running: "text-primary",
  failed: "text-destructive",
  cancelled: "text-warning",
  interrupted: "text-warning",
};

function jobTitle(j: JobRow): string {
  const p = j.payload ?? {};
  return (
    p.postTitle ?? p.projectName ?? p.outputFile ?? p.targetId ?? KIND_LABEL[j.kind] ?? j.kind
  );
}

export function ExportsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "exports" | "running" | "failed">("all");
  const jobs = useQuery({
    queryKey: ["jobs", filter],
    queryFn: () =>
      api.listJobs(
        filter === "exports" ? "render.export" : filter === "all" ? undefined : undefined,
        200,
      ),
    refetchInterval: 3000,
  });
  // Live refresh on any job finishing.
  useEffect(() => onJobFinished(() => void jobs.refetch()), [jobs]);

  const rows = useMemo(() => {
    let r = jobs.data ?? [];
    if (filter === "exports") r = r.filter((j) => j.kind.includes("export"));
    if (filter === "running") r = r.filter((j) => j.status === "running" || j.status === "queued");
    if (filter === "failed") r = r.filter((j) => j.status === "failed" || j.status === "interrupted");
    return r;
  }, [jobs.data, filter]);

  const cancel = async (j: JobRow) => {
    await api.cancelJob(j.id);
    void jobs.refetch();
  };

  const retry = async (j: JobRow) => {
    if (!j.payload.retryable || !j.payload.targetId) return;
    const outDir = j.payload.outputPath?.replace(/[\/][^\/]*$/, "") ?? "";
    try {
      const jobId = await api.exportForTarget(j.payload.targetId, outDir);
      toast.success("Export restarted");
      const f = await awaitJob(jobId);
      if (f.status !== "done") toast.error(`Export ${f.status}: ${f.error ?? ""}`);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Rocket className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Export Center</h1>
            <p className="text-xs text-muted-foreground">
              Every export and background job, live from the job log.
            </p>
          </div>
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["all", "exports", "running", "failed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1 text-xs capitalize",
                filter === f ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left">Job</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Progress</th>
              <th className="px-3 py-2 text-left">Started</th>
              <th className="px-3 py-2 text-left">Finished</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id} className="border-b border-border/50 align-middle">
                <td className="max-w-[260px] px-4 py-2">
                  <div className="truncate font-medium">{jobTitle(j)}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {j.payload.outputPath ?? j.id.slice(0, 8)}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">{KIND_LABEL[j.kind] ?? j.kind}</td>
                <td className={cn("px-3 py-2 text-xs capitalize", STATUS_TONE[j.status])}>
                  {j.status}
                </td>
                <td className="px-3 py-2">
                  <div className="h-1.5 w-24 rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(j.progress * 100)}%` }}
                    />
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{j.createdAt}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{j.finishedAt ?? "—"}</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {j.status === "running" && (
                      <Button size="sm" variant="ghost" title="Cancel" onClick={() => void cancel(j)}>
                        <XCircle className="size-4" />
                      </Button>
                    )}
                    {(j.status === "failed" || j.status === "cancelled") &&
                      j.payload.retryable && (
                        <Button size="sm" variant="ghost" title="Retry" onClick={() => void retry(j)}>
                          <RefreshCw className="size-4" />
                        </Button>
                      )}
                    {j.payload.outputPath && j.status === "done" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Show in folder"
                        onClick={() => void api.revealPath(j.payload.outputPath!)}
                      >
                        <FolderOpen className="size-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No jobs match this filter yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
