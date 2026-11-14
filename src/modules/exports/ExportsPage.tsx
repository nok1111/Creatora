import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, XCircle, RefreshCw, Rocket, Clapperboard } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api, type JobRow } from "@/lib/ipc";
import { useOpenInEditor } from "@/lib/open-in-editor";
import { SuggestionBanner } from "@/components/SuggestionBanner";
import { useProject } from "@/stores/project";
import { awaitJob, onJobFinished } from "@/services/jobs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

const KIND_KEYS: Record<string, string> = {
  "render.export": "kind_render_export",
  "social.export": "kind_social_export",
  "social.publish": "kind_social_publish",
  "media.import": "kind_media_import",
  "media.proxies": "kind_media_proxies",
  "reframe.analyze": "kind_reframe_analyze",
  "analytics.sync": "kind_analytics_sync",
  "download.model": "kind_download_model",
  "subtitles.download": "kind_download_model",
  "subtitles.transcribe": "kind_transcribe",
};

const STATUS_TONE: Record<string, string> = {
  done: "text-success",
  running: "text-primary",
  queued: "text-primary",
  failed: "text-destructive",
  cancelled: "text-warning",
  interrupted: "text-warning",
};

export function ExportsPage() {
  const qc = useQueryClient();
  const { t, i18n } = useTranslation();
  const doc = useProject((s) => s.doc);
  const { openPath, run } = useOpenInEditor();
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

  const fmtTime = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "short",
        timeStyle: "short",
      });
    } catch {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
    }
  }, [i18n.language]);
  const fmt = (iso?: string | null) => {
    if (!iso) return "—";
    // SQLite datetime('now') is UTC without a suffix — normalize so the
    // browser renders local time instead of raw UTC.
    const norm = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
    const d = new Date(norm);
    return Number.isNaN(d.getTime()) ? iso : fmtTime.format(d);
  };

  const kindLabel = (kind: string) => {
    const k = KIND_KEYS[kind];
    return k ? t(`exports.${k}`) : kind;
  };
  const statusLabel = (status: string) =>
    t(`exports.status_${status}`, { defaultValue: status });

  const rows = useMemo(() => {
    let r = jobs.data ?? [];
    if (filter === "exports") r = r.filter((j) => j.kind.includes("export"));
    if (filter === "running") r = r.filter((j) => j.status === "running" || j.status === "queued");
    if (filter === "failed") r = r.filter((j) => j.status === "failed" || j.status === "interrupted");
    return r;
  }, [jobs.data, filter]);

  const jobTitle = (j: JobRow): string => {
    const p = j.payload ?? {};
    return p.postTitle ?? p.projectName ?? p.outputFile ?? p.targetId ?? kindLabel(j.kind);
  };

  const cancel = async (j: JobRow) => {
    await api.cancelJob(j.id);
    void jobs.refetch();
  };

  const retry = async (j: JobRow) => {
    if (!j.payload.retryable || !j.payload.targetId) return;
    const outDir = j.payload.outputPath?.replace(/[\/][^\/]*$/, "") ?? "";
    try {
      const jobId = await api.exportForTarget(j.payload.targetId, outDir);
      toast.success(t("exports.restarted"));
      const f = await awaitJob(jobId);
      if (f.status !== "done")
        toast.error(t("exports.restartFailed", { status: statusLabel(f.status) }), {
          description: f.error ?? undefined,
        });
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
            <h1 className="text-xl font-semibold">{t("exports.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("exports.subtitle")}</p>
          </div>
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["all", "exports", "running", "failed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1 text-xs",
                filter === f ? "bg-secondary" : "text-muted-foreground",
              )}
            >
              {t(`exports.filter_${f}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <SuggestionBanner doc={doc} only={["adapt-vertical", "prepare-publish"]} />
      </div>

      <div className="mt-5 rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left">{t("exports.col_job")}</th>
              <th className="px-3 py-2 text-left">{t("exports.col_type")}</th>
              <th className="px-3 py-2 text-left">{t("exports.col_status")}</th>
              <th className="px-3 py-2 text-left">{t("exports.col_progress")}</th>
              <th className="px-3 py-2 text-left">{t("exports.col_started")}</th>
              <th className="px-3 py-2 text-left">{t("exports.col_finished")}</th>
              <th className="px-4 py-2 text-right">{t("exports.col_actions")}</th>
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
                  {j.status === "failed" && (
                    <div className="mt-0.5 text-[10px] text-destructive">
                      {t("exports.failedHint")}{" "}
                      <span
                        className="line-clamp-2 break-all font-mono"
                        title={j.error ?? undefined}
                      >
                        {j.error ?? "—"}
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{kindLabel(j.kind)}</td>
                <td className={cn("px-3 py-2 text-xs", STATUS_TONE[j.status])}>
                  {statusLabel(j.status)}
                </td>
                <td className="px-3 py-2">
                  <div className="h-1.5 w-24 rounded-full bg-secondary">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        j.status === "failed" || j.status === "interrupted"
                          ? "bg-destructive/70"
                          : j.status === "cancelled"
                            ? "bg-warning/70"
                            : "bg-primary",
                      )}
                      style={{ width: `${Math.round(j.progress * 100)}%` }}
                    />
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{fmt(j.createdAt)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{fmt(j.finishedAt)}</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {j.payload.projectPath && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("openInEditor.open")}
                        aria-label={t("openInEditor.open")}
                        onClick={() => run(() => openPath(j.payload.projectPath!))}
                      >
                        <Clapperboard className="size-4" />
                      </Button>
                    )}
                    {j.status === "running" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("exports.cancel")}
                        aria-label={t("exports.cancel")}
                        onClick={() => void cancel(j)}
                      >
                        <XCircle className="size-4" />
                      </Button>
                    )}
                    {(j.status === "failed" || j.status === "cancelled") &&
                      j.payload.retryable && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={t("exports.retry")}
                          aria-label={t("exports.retry")}
                          onClick={() => void retry(j)}
                        >
                          <RefreshCw className="size-4" />
                        </Button>
                      )}
                    {j.payload.outputPath && j.status === "done" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("exports.showInFolder")}
                        aria-label={t("exports.showInFolder")}
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
                <td colSpan={7} className="px-4 py-6">
                  <EmptyState
                    compact
                    icon={Rocket}
                    title={t("exports.emptyTitle")}
                    body={
                      filter === "failed"
                        ? t("exports.emptyFailedBody")
                        : t("exports.emptyBody")
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
