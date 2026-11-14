/**
 * Autosave foundation (ADR/Phase-1).
 *
 * Any module registers a named saver with a dirty-check. The service ticks on
 * a configurable interval and also flushes pending saves on window close.
 * Phase 2 wires project documents into this; the mechanism is already testable.
 */

export interface AutosaveSource {
  /** Stable id, e.g. "project:<uuid>" */
  id: string;
  /** True when there is unsaved work. Must be cheap — runs every tick. */
  isDirty: () => boolean;
  /** Persist current state. Rejects on failure; service reports via onError. */
  save: () => Promise<void>;
}

type ErrorHandler = (id: string, error: unknown) => void;

class AutosaveService {
  private sources = new Map<string, AutosaveSource>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 30_000;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private onError: ErrorHandler = (id, e) =>
    console.error(`[autosave] save failed for ${id}:`, e);

  register(source: AutosaveSource): () => void {
    this.sources.set(source.id, source);
    return () => this.sources.delete(source.id);
  }

  setIntervalMs(ms: number) {
    this.intervalMs = Math.max(1_000, ms);
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  setErrorHandler(handler: ErrorHandler) {
    this.onError = handler;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    window.addEventListener("beforeunload", this.flushSync);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("beforeunload", this.flushSync);
  }

  private lastErrors = new Map<string, unknown>();

  /** Run one save pass over all dirty sources. Serial to avoid write races. */
  async tick(): Promise<void> {
    this.lastErrors.clear();
    for (const source of this.sources.values()) {
      try {
        if (source.isDirty()) await source.save();
      } catch (e) {
        this.lastErrors.set(source.id, e);
        this.onError(source.id, e);
      }
    }
  }

  /**
   * Serialize save passes through a single promise chain so a caller can
   * await "everything pending" — e.g. before replacing the open document.
   * Errors are reported per-source via onError; flush itself never rejects.
   */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.tick()).catch(() => {});
    return this.chain;
  }

  /**
   * Like flush() but resolves with the ids of sources whose save failed in
   * the last pass — a project switch can then decide to keep the document.
   */
  async flushWithErrors(): Promise<string[]> {
    await this.flush();
    return [...this.lastErrors.keys()];
  }

  /** Best-effort flush on unload — async work can't be awaited here. */
  private flushSync = () => {
    void this.flush();
  };
}

export const autosave = new AutosaveService();
