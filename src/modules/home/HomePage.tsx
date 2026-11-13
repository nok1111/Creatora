import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, Clock, Film, Star, MoreVertical, FolderOpen, Archive, Copy, Trash2, Undo2, PackageOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/ipc";
import type { ProjectSummary } from "@/lib/project-types";
import { useProject } from "@/stores/project";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { NewProjectDialog } from "./NewProjectDialog";

function relativeTime(iso: string, locale: string): string {
  const then = new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

export function HomePage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const project = useProject();
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteFileToo, setDeleteFileToo] = useState(false);

  const info = useQuery({ queryKey: ["app-info"], queryFn: api.appInfo, retry: false });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });

  useEffect(() => {
    if (info.error) toast.error(t("common.error"), { description: String(info.error) });
    if (projects.error) toast.error(t("common.error"), { description: String(projects.error) });
  }, [info.error, projects.error, t]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["projects"] });

  const openProject = async (p: ProjectSummary) => {
    try {
      await project.openFromPath(p.filePath);
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const flag = async (id: string, flags: { favorite?: boolean; archived?: boolean }) => {
    try {
      await api.setProjectFlag(id, flags);
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const exportBundle = async (p: ProjectSummary) => {
    const dest = await openDialog({ directory: true, title: t("home.exportBundleDest") });
    if (typeof dest !== "string" || !dest) return;
    try {
      const r = await api.exportProjectBundle(p.id, dest);
      toast.success(
        r.mediaMissing.length
          ? t("home.exportBundlePartial", { dir: r.bundleDir, count: r.mediaMissing.length })
          : t("home.exportBundleDone", { dir: r.bundleDir }),
      );
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const duplicate = async (id: string) => {
    try {
      await api.duplicateProject(id);
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteProject(deleteTarget.id, deleteFileToo);
      toast.success(t("home.projectDeleted"));
      setDeleteTarget(null);
      setDeleteFileToo(false);
      refresh();
    } catch (e) {
      toast.error(t("common.error"), { description: String(e) });
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("home.title")}</h1>
        <Button onClick={() => setNewOpen(true)}>
          <FilePlus2 />
          {t("home.newProject")}
        </Button>
      </div>

      {/* Recovery prompt — shown when opening a project with a newer autosave */}
      {project.recovery && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-primary/50 bg-accent p-4">
          <Undo2 className="size-5 shrink-0 text-primary" />
          <p className="flex-1 text-sm">{t("home.recoveryFound")}</p>
          <Button size="sm" onClick={() => void project.acceptRecovery()}>
            {t("home.recoveryRestore")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void project.discardRecovery()}>
            {t("home.recoveryDiscard")}
          </Button>
        </div>
      )}

      {/* Currently open project indicator */}
      {project.doc && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-card p-4">
          <FolderOpen className="size-4 text-primary" />
          <span className="text-sm">
            {project.doc.meta.name}
            {project.dirty && <span className="ml-2 text-muted-foreground">({t("home.unsaved")})</span>}
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void project.save()} disabled={!project.dirty}>
              {t("common.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => project.close()}>
              {t("common.close")}
            </Button>
          </span>
        </div>
      )}

      <section className="mt-8">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("home.recentProjects")}
          </h2>
        </div>

        {projects.isLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : !projects.data?.length ? (
          <div className="mt-3 rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium">{t("home.emptyProjects")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("home.emptyProjectsHint")}</p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
            {projects.data.map((p) => (
              <li key={p.id} className="flex items-center gap-3 p-3">
                <button
                  className="flex flex-1 items-center gap-3 text-left"
                  onClick={() => void openProject(p)}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded bg-secondary text-xs font-semibold text-muted-foreground">
                    {p.width && p.height ? `${p.width}×${p.height}` : "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {relativeTime(p.lastOpenedAt ?? p.modifiedAt, i18n.language)}
                      {" · "}
                      {p.filePath}
                    </p>
                  </div>
                </button>
                {p.isFavorite && <Star className="size-4 fill-primary text-primary" />}
                <DropdownMenu>
                  <DropdownMenuTrigger className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
                    <MoreVertical className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void openProject(p)}>
                      <FolderOpen className="size-4" /> {t("home.open")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void flag(p.id, { favorite: !p.isFavorite })}>
                      <Star className="size-4" /> {p.isFavorite ? t("home.unfavorite") : t("home.favorite")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void duplicate(p.id)}>
                      <Copy className="size-4" /> {t("home.duplicate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void flag(p.id, { archived: true })}>
                      <Archive className="size-4" /> {t("home.archive")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void exportBundle(p)}>
                      <PackageOpen className="size-4" /> {t("home.exportBundle")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onClick={() => setDeleteTarget(p)}>
                      <Trash2 className="size-4" /> {t("home.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <div className="flex items-center gap-2">
          <Film className="size-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("home.recentExports")}
          </h2>
        </div>
        <div className="mt-3 rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("home.emptyExports")}</p>
        </div>
      </section>

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />

      {/* Delete confirmation — destructive action requires explicit confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("home.deleteTitle", { name: deleteTarget?.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("home.deleteDesc")}</AlertDialogDescription>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteFileToo}
              onChange={(e) => setDeleteFileToo(e.target.checked)}
              className="size-4 accent-[hsl(var(--primary))]"
            />
            {t("home.deleteFileToo")}
          </label>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void doDelete()}>
              {t("home.delete")}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
