import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface JobProgress {
  jobId: string;
  progress: number; // 0–1, -1 = indeterminate
  label?: string;
}

export interface JobFinished<T = unknown> {
  jobId: string;
  status: "done" | "failed" | "cancelled";
  result?: T;
  error?: string;
}

type ProgressHandler = (p: JobProgress) => void;
type FinishedHandler = (f: JobFinished) => void;

let progressUnlisten: Promise<UnlistenFn> | null = null;
let finishedUnlisten: Promise<UnlistenFn> | null = null;
const progressHandlers = new Set<ProgressHandler>();
const finishedHandlers = new Set<FinishedHandler>();

function ensureListeners() {
  progressUnlisten ??= listen<JobProgress>("job://progress", (e) => {
    progressHandlers.forEach((h) => h(e.payload));
  });
  finishedUnlisten ??= listen<JobFinished>("job://finished", (e) => {
    finishedHandlers.forEach((h) => h(e.payload));
  });
}

/**
 * Register the global job listeners up front. Callers should await this
 * BEFORE spawning a job — the `job://finished` event is transient, so a
 * job that ends before `listen()` registers would be missed forever.
 */
export async function primeJobListeners(): Promise<void> {
  ensureListeners();
  await Promise.all([progressUnlisten, finishedUnlisten]);
}

/** Wait for a specific job's finish event. Returns a cleanup function too. */
export function awaitJob<T>(jobId: string): Promise<JobFinished<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (f: JobFinished) => {
      if (done || f.jobId !== jobId) return;
      done = true;
      finishedHandlers.delete(handler);
      resolve(f as JobFinished<T>);
    };
    const handler = (f: JobFinished) => finish(f);
    onJobFinished(handler);
    // Race guard: the job may have finished between spawn and listener
    // registration — the durable row holds the truth, the error text is
    // only on the (already missed) event so it falls back to a generic.
    void primeJobListeners()
      .then(() =>
        invoke<{ id: string; status: string; payload?: { outputPath?: string } }[]>(
          "list_jobs",
          { kindPrefix: null, limit: 200 },
        ),
      )
      .then((rows) => {
        const row = rows.find((r) => r.id === jobId);
        if (row && row.status !== "running") {
          finish({
            jobId,
            status: row.status === "done" ? "done" : row.status === "cancelled" ? "cancelled" : "failed",
            result: row.payload?.outputPath
              ? ({ outputPath: row.payload.outputPath } as T)
              : undefined,
          });
        }
      })
      .catch(() => {});
  });
}

export function onJobProgress(h: ProgressHandler): () => void {
  progressHandlers.add(h);
  ensureListeners();
  return () => progressHandlers.delete(h);
}

export function onJobFinished(h: FinishedHandler): () => void {
  finishedHandlers.add(h);
  ensureListeners();
  return () => finishedHandlers.delete(h);
}
