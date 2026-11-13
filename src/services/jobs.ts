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

/** Wait for a specific job's finish event. Returns a cleanup function too. */
export function awaitJob<T>(jobId: string): Promise<JobFinished<T>> {
  return new Promise((resolve) => {
    const handler = (f: JobFinished) => {
      if (f.jobId === jobId) {
        finishedHandlers.delete(handler);
        resolve(f as JobFinished<T>);
      }
    };
    onJobFinished(handler);
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
