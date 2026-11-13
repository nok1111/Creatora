import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { FilePlus2, Clock, Film } from "lucide-react";
import { api } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function HomePage() {
  const { t } = useTranslation();
  const info = useQuery({
    queryKey: ["app-info"],
    queryFn: api.appInfo,
    retry: false,
  });

  useEffect(() => {
    if (info.error) {
      toast.error(t("common.error"), { description: String(info.error) });
    }
  }, [info.error, t]);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">{t("home.title")}</h1>

      <section className="mt-8">
        <div className="flex items-center gap-2">
          <FilePlus2 className="size-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("home.newProject")}
          </h2>
        </div>
        <div className="mt-3 rounded-lg border border-dashed border-border p-6">
          <p className="text-sm text-muted-foreground">
            {t("home.newProjectHint")}
          </p>
          <Button className="mt-4" disabled>
            {t("home.newProject")}
          </Button>
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("home.recentProjects")}
          </h2>
        </div>
        <div className="mt-3 rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium">{t("home.emptyProjects")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("home.emptyProjectsHint")}
          </p>
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center gap-2">
          <Film className="size-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t("home.recentExports")}
          </h2>
        </div>
        <div className="mt-3 rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t("home.emptyExports")}
          </p>
        </div>
      </section>

      <section className="mt-8 rounded-lg bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("home.appInfo")}
        </h2>
        {info.isLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("common.loading")}
          </p>
        ) : info.data ? (
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Creatora</dt>
              <dd>{t("home.version", { version: info.data.version })}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t("home.dataDir")}</dt>
              <dd className="truncate font-mono text-xs">{info.data.dataDir}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t("home.ffmpeg")}</dt>
              <dd className={info.data.ffmpegVersion ? "" : "text-destructive"}>
                {info.data.ffmpegVersion ?? t("home.ffmpegMissing")}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>
    </div>
  );
}
