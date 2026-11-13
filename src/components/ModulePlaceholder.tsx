import { useTranslation } from "react-i18next";
import type { ModuleDef } from "@/app/nav";

/**
 * Honest placeholder for scaffolded-but-unimplemented modules.
 * Never fakes functionality — shows the planned phase explicitly.
 */
export function ModulePlaceholder({ module }: { module: ModuleDef }) {
  const { t } = useTranslation();
  const Icon = module.icon;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-secondary">
        <Icon className="size-8 text-muted-foreground" />
      </div>
      <div>
        <h1 className="text-xl font-semibold">{t(`nav.${module.key}`)}</h1>
        <p className="mt-1 text-sm font-medium text-primary">
          {t("placeholder.phase", { phase: module.phase })}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {t("placeholder.description")}
        </p>
      </div>
    </div>
  );
}
