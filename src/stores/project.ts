import { create } from "zustand";
import { api } from "@/lib/ipc";
import { autosave } from "@/services/autosave";
import type {
  OpenProjectResult,
  ProjectDoc,
  ProjectSummary,
} from "@/lib/project-types";

export type RecoveryOffer = { projectId: string; autosavePath: string } | null;

interface ProjectState {
  /** Currently open project (null = none open). */
  doc: ProjectDoc | null;
  filePath: string | null;
  dirty: boolean;
  /** Non-null while a recovery decision is pending. */
  recovery: RecoveryOffer;

  setDoc: (doc: ProjectDoc) => void;
  markDirty: () => void;
  applyOpenResult: (r: OpenProjectResult) => RecoveryOffer;
  save: () => Promise<void>;
  openFromPath: (path: string) => Promise<RecoveryOffer>;
  createNew: (opts: {
    name: string;
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
  }) => Promise<RecoveryOffer>;
  acceptRecovery: () => Promise<void>;
  discardRecovery: () => Promise<void>;
  close: () => void;
}

export const useProject = create<ProjectState>((set, get) => ({
  doc: null,
  filePath: null,
  dirty: false,
  recovery: null,

  setDoc: (doc) => set({ doc, dirty: true }),
  markDirty: () => set({ dirty: true }),

  applyOpenResult: (r) => {
    set({ doc: r.doc, filePath: r.filePath, dirty: false });
    const offer: RecoveryOffer = r.recoveryPath
      ? { projectId: r.doc.meta.id, autosavePath: r.recoveryPath }
      : null;
    set({ recovery: offer });
    return offer;
  },

  save: async () => {
    const { doc, filePath } = get();
    if (!doc || !filePath) return;
    await api.saveProject(filePath, doc);
    set({ dirty: false });
  },

  openFromPath: async (path) => {
    const r = await api.openProject(path);
    return get().applyOpenResult(r);
  },

  createNew: async (opts) => {
    const r = await api.createProject(opts);
    return get().applyOpenResult(r);
  },

  acceptRecovery: async () => {
    const { recovery } = get();
    if (!recovery) return;
    const doc = await api.recoverProject(recovery.projectId);
    // Recovered content is dirty until explicitly saved over the file.
    set({ doc, dirty: true, recovery: null });
  },

  discardRecovery: async () => {
    const { recovery } = get();
    if (!recovery) return;
    await api.discardRecovery(recovery.projectId);
    set({ recovery: null });
  },

  close: () => set({ doc: null, filePath: null, dirty: false, recovery: null }),
}));

// Register the open project as an autosave source — dirty docs get saved to
// the autosaves dir every interval without touching the real file.
autosave.register({
  id: "open-project",
  isDirty: () => useProject.getState().dirty && useProject.getState().doc !== null,
  save: async () => {
    const { doc } = useProject.getState();
    if (doc) await api.autosaveProject(doc);
  },
});

export type { ProjectSummary };
