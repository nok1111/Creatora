import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { api } from "@/lib/ipc";
import type { ImportPreview } from "@/lib/analytics-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SourceBadge } from "./charts";
import { useTranslation } from "react-i18next";

export function ImportPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const batches = useQuery({
    queryKey: ["import-batches"],
    queryFn: () => api.analyticsImportBatches(),
  });

  const pick = async () => {
    const p = await open({
      filters: [{ name: t("ana.fileFilter"), extensions: ["csv", "json"] }],
      multiple: false,
    });
    if (typeof p === "string") setPath(p);
  };

  const doPreview = async () => {
    if (!path) return;
    setBusy(true);
    try {
      setPreview(await api.analyticsImportPreview(path));
    } catch (e) {
      toast.error(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!path || !preview) return;
    setBusy(true);
    try {
      const r = (await api.analyticsImportCommit(path, label || "manual import")) as {
        imported: number;
        skipped: number;
        errors: string[];
      };
      toast.success(`Imported ${r.imported} rows, skipped ${r.skipped}`);
      setPreview(null);
      void qc.invalidateQueries({ queryKey: ["import-batches"] });
      void qc.invalidateQueries({ queryKey: ["analytics-dashboard"] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="text-sm font-medium">{t("ana.importExternal")}</div>
        <p className="text-xs text-muted-foreground">
          CSV or JSON export from a platform/analytics tool. Columns are
          validated; rows whose remote id can't be matched to a published
          target are skipped. Imported data is always tagged{" "}
          <SourceBadge source="import" /> and never overwrites existing
          snapshots.
        </p>
        <div className="flex items-center gap-2">
          <Input
            className="max-w-md text-xs"
            placeholder="C:\…\export.csv or .json"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={() => void pick()}>
            Browse
          </Button>
          <Button size="sm" disabled={!path || busy} onClick={() => void doPreview()}>
            Preview
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("ana.sourceLabel")}</span>
          <Input
            className="max-w-xs text-xs"
            placeholder={t("ana.labelPh")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      </div>

      {preview && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center gap-4 text-xs">
            <b>{preview.format.toUpperCase()}</b>
            <span>{preview.rowsSeen} rows</span>
            <span className="text-success">{preview.matched} matched</span>
            <span className="text-warning">{preview.unmatched} unmatched</span>
            <Button size="sm" className="ml-auto" disabled={busy || preview.matched === 0} onClick={() => void commit()}>
              <Upload size={13} className="mr-1" /> Import {preview.matched} rows
            </Button>
          </div>
          {preview.issues.length > 0 && (
            <div className="rounded bg-destructive/10 p-2 text-[11px] text-destructive">
              {preview.issues.slice(0, 6).map((i, k) => (
                <div key={k}>{i}</div>
              ))}
              {preview.issues.length > 6 && <div>…{preview.issues.length - 6} more</div>}
            </div>
          )}
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-1 text-left">{t("ana.col_platform")}</th>
                <th className="py-1 text-left">{t("ana.col_remoteId")}</th>
                <th className="py-1 text-left">{t("ana.col_metrics")}</th>
                <th className="py-1 text-left">{t("ana.col_match")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 25).map((r, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1 capitalize">{r.platform}</td>
                  <td className="py-1 font-mono">{r.remoteId}</td>
                  <td className="py-1">
                    {r.metrics.map(([k, v]) => `${k}=${v}`).join(" ")}
                  </td>
                  <td className="py-1">
                    {r.targetId ? (
                      <span className="text-success">{t("ana.targetFound")}</span>
                    ) : (
                      <span className="text-warning">{t("ana.noMatch")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 25 && (
            <div className="text-[11px] text-muted-foreground">
              …{preview.rows.length - 25} more rows
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          Import history
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left">{t("ana.col_file")}</th>
              <th className="px-2 py-1.5 text-left">{t("ana.col_label")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.seen")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.imported")}</th>
              <th className="px-2 py-1.5 text-right">{t("ana.skipped")}</th>
              <th className="px-3 py-1.5 text-left">{t("ana.col_when")}</th>
            </tr>
          </thead>
          <tbody>
            {(batches.data ?? []).map((b) => (
              <tr key={b.id} className="border-b border-border/50">
                <td className="px-3 py-1.5">{b.filename}</td>
                <td className="px-2 py-1.5">{b.sourceLabel}</td>
                <td className="px-2 py-1.5 text-right">{b.rowsSeen}</td>
                <td className="px-2 py-1.5 text-right">{b.rowsImported}</td>
                <td className="px-2 py-1.5 text-right">{b.rowsSkipped}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{b.createdAt}</td>
              </tr>
            ))}
            {(batches.data ?? []).length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                No imports yet.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
