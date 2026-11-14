import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/ipc";
import { useProject } from "@/stores/project";
import { requestProjectSwitch } from "@/services/project-switch";

/**
 * Single entry point for "open this project file and show it in the editor".
 * The unsaved-changes guard (Fase 3D) hooks in here so every caller
 * (Home, Social, Exports…) goes through the same protection.
 */
export function useOpenInEditor() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const openPath = useCallback(
    async (filePath: string) => {
      const st = useProject.getState();
      if (st.filePath === filePath && st.doc) {
        navigate("/editor");
        return;
      }
      requestProjectSwitch(async () => {
        await st.openFromPath(filePath);
        navigate("/editor");
      });
    },
    [navigate],
  );

  /** Resolve a project id (as linked from social posts/versions) then open it. */
  const openById = useCallback(
    async (projectId: string) => {
      const st = useProject.getState();
      if (st.doc?.meta.id === projectId) {
        navigate("/editor");
        return;
      }
      const projects = await api.listProjects();
      const p = projects.find((x) => x.id === projectId);
      if (!p) {
        toast.error(t("openInEditor.notFound"));
        return;
      }
      await openPath(p.filePath);
    },
    [navigate, openPath, t],
  );

  const run = useCallback(
    (fn: () => Promise<void>) => {
      void fn().catch((e) =>
        toast.error(t("common.error"), { description: String(e) }),
      );
    },
    [t],
  );

  return { openPath, openById, run };
}
