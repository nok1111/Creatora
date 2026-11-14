import { useTranslation } from "react-i18next";
import { useProject } from "@/stores/project";
import {
  cancelProjectSwitch,
  confirmProjectSwitch,
  useSwitchGuard,
} from "@/services/project-switch";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Global unsaved-work guard — mounted once in AppShell. Whenever a project
 * replace/close/create is requested with a dirty doc, this dialog asks the
 * user to save, continue without saving (autosave keeps a backup), or
 * cancel. Save/backup failures keep the current document and show the error.
 */
export function ProjectSwitchDialog() {
  const { t } = useTranslation();
  const { pending, busy, error } = useSwitchGuard();
  const doc = useProject((s) => s.doc);

  return (
    <AlertDialog
      open={!!pending}
      onOpenChange={(v) => !v && !busy && cancelProjectSwitch()}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{t("switchGuard.title")}</AlertDialogTitle>
        <AlertDialogDescription>
          {t("switchGuard.desc", { name: doc?.meta.name ?? "" })}
        </AlertDialogDescription>
        {error && (
          <p className="mt-3 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={cancelProjectSwitch} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void confirmProjectSwitch("skip")}
          >
            {t("switchGuard.dontSave")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void confirmProjectSwitch("save")}
          >
            {busy ? t("switchGuard.saving") : t("switchGuard.saveContinue")}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
