import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/ipc";
import { useSettings, type Theme } from "@/stores/settings";
import { SUPPORTED_LANGUAGES, type LanguageCode } from "@/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-3 space-y-4 rounded-lg border border-border bg-card p-5">
        {children}
      </div>
    </section>
  );
}

function Row({ label, control }: { label: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {control}
    </div>
  );
}

function ChoiceGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-input p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-3 py-1 text-sm transition-colors",
            o.value === value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { theme, language, autosaveIntervalSec, setTheme, setLanguage, setAutosaveInterval } =
    useSettings();
  const info = useQuery({ queryKey: ["app-info"], queryFn: api.appInfo, retry: false });

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("settings.storageNote")}
      </p>

      <Section title={t("settings.appearance")}>
        <Row
          label={t("settings.theme")}
          control={
            <ChoiceGroup<Theme>
              value={theme}
              onChange={(v) => {
                setTheme(v);
                toast.success(t("settings.saved"));
              }}
              options={[
                { value: "dark", label: t("settings.themeDark") },
                { value: "light", label: t("settings.themeLight") },
              ]}
            />
          }
        />
        <Row
          label={t("settings.language")}
          control={
            <ChoiceGroup<LanguageCode>
              value={language}
              onChange={(v) => {
                setLanguage(v);
                toast.success(t("settings.saved"));
              }}
              options={SUPPORTED_LANGUAGES.map((l) => ({
                value: l.code,
                label: l.label,
              }))}
            />
          }
        />
      </Section>

      <Section title={t("settings.workspace")}>
        <Row
          label={t("settings.autosaveInterval")}
          control={
            <input
              type="number"
              min={5}
              max={600}
              value={autosaveIntervalSec}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setAutosaveInterval(v);
              }}
              className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right text-sm"
            />
          }
        />
      </Section>

      <Section title={t("settings.about")}>
        {info.data && (
          <dl className="space-y-1 text-sm">
            <Row label="Creatora" control={<span>{info.data.version}</span>} />
            <Row
              label={t("home.ffmpeg")}
              control={
                <span className={info.data.ffmpegVersion ? "" : "text-destructive"}>
                  {info.data.ffmpegVersion ?? t("home.ffmpegMissing")}
                </span>
              }
            />
          </dl>
        )}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => info.refetch()}
        >
          {t("common.retry")}
        </Button>
      </Section>
    </div>
  );
}
