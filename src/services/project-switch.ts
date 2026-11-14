import { create } from "zustand";
import { autosave } from "./autosave";
import { useProject } from "@/stores/project";
import { reportError } from "@/lib/errors";

/**
 * Unsaved-work guard for project switching (Fase 3D).
 *
 * Every path that replaces or drops the open document goes through
 * requestProjectSwitch. A pending autosave always finishes first; with a
 * dirty doc the user must explicitly choose to save, continue without
 * saving, or cancel. If the save (or the autosave backup) fails, the
 * current document is kept and the error is surfaced.
 */

export type SwitchMode = "save" | "skip";

interface SwitchGuardState {
  /** The deferred open/create/close action awaiting a decision. */
  pending: (() => Promise<void>) | null;
  busy: boolean;
  error: string | null;
}

export const useSwitchGuard = create<SwitchGuardState>(() => ({
  pending: null,
  busy: false,
  error: null,
}));

/**
 * Replace/close the current project safely. Runs `action` immediately when
 * there is nothing unsaved; otherwise shows the guard dialog and defers the
 * action until the user decides. Pending autosave work is awaited either
 * way, so the replacement never races a half-written backup.
 */
export function requestProjectSwitch(action: () => Promise<void>) {
  const { doc, dirty } = useProject.getState();
  if (!doc || !dirty) {
    void autosave.flush().then(() =>
      action().catch((e) => {
        // Even on the fast path a failed open must not lose the current doc —
        // openFromPath only replaces state on success, so just report it.
        reportError(e);
      }),
    );
    return;
  }
  useSwitchGuard.setState({ pending: action, busy: false, error: null });
}

/** User confirmed: save first ("save") or trust the autosave backup ("skip"). */
export async function confirmProjectSwitch(mode: SwitchMode): Promise<void> {
  const { pending } = useSwitchGuard.getState();
  if (!pending) return;
  useSwitchGuard.setState({ busy: true, error: null });
  try {
    const failed = await autosave.flushWithErrors();
    if (mode === "save") {
      await useProject.getState().save();
    } else if (failed.includes("open-project")) {
      // The user chose not to save and the backup also failed — the doc would
      // be lost for real. Keep it and surface the error instead.
      throw new Error("autosave backup failed");
    }
    await pending();
    useSwitchGuard.setState({ pending: null, busy: false });
  } catch (e) {
    // Keep the current document; the dialog stays open for retry/cancel.
    useSwitchGuard.setState({ busy: false, error: String(e) });
  }
}

export function cancelProjectSwitch() {
  useSwitchGuard.setState({ pending: null, busy: false, error: null });
}
