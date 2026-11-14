import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, Clock, Film, Star, MoreVertical, FolderOpen, Archive, Copy, Trash2, Undo2, PackageOpen,
  Clapperboard, Smartphone, Captions, Image, AudioLines, Share2, Upload, ArrowRight, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
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
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";

/** Mini aspect-ratio tile for the recents list. */
function AspectTile({ w, h }: { w: number | null; h: number | null }) {
  const ar = w && h ? w / h : 16 / 9;
  const max = 26;
  const tw = ar >= 1 ? max : Math.max(10, Math.round(max * ar));
  const th = ar >= 1 ? Math.max(10, Math.round(max / ar)) : max;
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-0">
      <div
        className="flex items-center justify-center rounded-[3px] border border-primary/40 bg-primary/10"
        style={{ width: tw, height: th }}
      />
    </div>
  );
}

const JOB_TONE: Record<string, string> = {
  done: "bg-success/15 text-success",
  running: "bg-primary/15 text-primary",
  queued: "bg-secondary text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
  interrupted: "bg-destructive/15 text-destructive",
  cancelled: "bg-secondary text-muted-foreground",
};

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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const project = useProject();
  // creation now happens in /create
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteFileToo, setDeleteFileToo] = useState(false);

  const info = useQuery({ queryKey: ["app-info"], queryFn: api.appInfo, retry: false });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const exportJobs = useQuery({
    queryKey: ["home-export-jobs"],
    queryFn: () => api.listJobs("render.export", 5),
    refetchInterval: 10_000,
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
      navigate("/editor");
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

  const hasOpen = !!project.doc;
  const cards: {
    icon: typeof Clapperboard;
    title: string;
    desc: string;
    tone: "coral" | "lavender" | "neutral";
    action: () => void;
  }[] = [
    { icon: Clapperboard, title: t("home.makeVideo"), desc: t("home.makeVideoDesc"), tone: "coral", action: () => navigate("/create?format=yt") },
    { icon: Smartphone, title: t("home.makeShort"), desc: t("home.makeShortDesc"), tone: "coral", action: () => navigate("/create?format=vert") },
    { icon: Captions, title: t("home.makeSubs"), desc: t("home.makeSubsDesc"), tone: "lavender", action: () => navigate(hasOpen ? "/editor?tab=subtitles" : "/create") },
    { icon: Image, title: t("home.makeThumb"), desc: t("home.makeThumbDesc"), tone: "lavender", action: () => navigate(hasOpen ? "/editor?left=graphics" : "/create?format=sq") },
    { icon: AudioLines, title: t("home.makeAudio"), desc: t("home.makeAudioDesc"), tone: "lavender", action: () => navigate(hasOpen ? "/editor" : "/create") },
    { icon: Share2, title: t("home.makePost"), desc: t("home.makePostDesc"), tone: "neutral", action: () => navigate("/social") },
  ];
  const chip = {
    coral: "bg-primary/15 text-primary",
    lavender: "bg-accent text-accent-foreground",
    neutral: "bg-secondary text-secondary-foreground",
  } as const;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      {/* Hero: answer "what can I make today?" */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("home.greeting")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.doc?.meta.name ?? t("home.emptyProjectsHint")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate("/library")}>
            <Upload />
            {t("library.importMedia", { defaultValue: "Import media" })}
          </Button>
          <Button onClick={() => navigate("/create")}>
            <FilePlus2 />
            {t("home.newProject")}
          </Button>
        </div>
      </div>

      {/* Creation cards — one click to the right tool */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        {cards.map((c) => (
          <button
            key={c.title}
            onClick={c.action}
            className="group flex items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-md"
          >
            <div className={`flex size-11 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105 ${chip[c.tone]}`}>
              <c.icon className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">{c.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{c.desc}</div>
            </div>
          </button>
        ))}
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
            <Button size="sm" onClick={() => navigate("/editor")}>
              {t("nav.openInEditor")}
            </Button>
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
          <div className="mt-3 rounded-lg border border-dashed border-border">
            <EmptyState
              compact
              icon={Clapperboard}
              title={t("home.emptyProjects")}
              body={t("home.emptyProjectsHint")}
              action={{ label: t("home.newProject"), onClick: () => navigate("/create") }}
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
            {projects.data.map((p) => (
              <li key={p.id} className="flex items-center gap-3 p-3">
                <button
                  className="flex flex-1 items-center gap-3 text-left"
                  onClick={() => void openProject(p)}
                >
                  <AspectTile w={p.width} h={p.height} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.width && p.height ? `${p.width}×${p.height} · ` : ""}
                      {relativeTime(p.lastOpenedAt ?? p.modifiedAt, i18n.language)}
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
          {!!exportJobs.data?.length && (
            <button
              className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              onClick={() => navigate("/exports")}
            >
              {t("home.viewAll", { defaultValue: "View all" })} <ArrowRight className="size-3" />
            </button>
          )}
        </div>
        {!exportJobs.data?.length ? (
          <div className="mt-3 rounded-lg border border-dashed border-border">
            <EmptyState
              compact
              icon={Film}
              title={t("home.emptyExports")}
              body="Exported videos will appear here."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
            {exportJobs.data.map((j) => (
              <li key={j.id} className="flex items-center gap-3 p-3">
                {j.status === "done" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                ) : j.status === "running" || j.status === "queued" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {j.payload.outputFile ?? j.payload.projectName ?? j.kind}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {relativeTime(j.createdAt, i18n.language)}
                  </p>
                </div>
                {j.status === "running" && (
                  <span className="text-xs text-primary">{Math.round(j.progress * 100)}%</span>
                )}
                <span className={cn("rounded-full px-2 py-0.5 text-2xs font-medium", JOB_TONE[j.status] ?? JOB_TONE.queued)}>
                  {j.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
