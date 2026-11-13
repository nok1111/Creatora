import { invoke } from "@tauri-apps/api/core";

/** Serialized error shape returned by every Rust command. */
export interface AppErrorPayload {
  code: string;
  message: string;
  details?: string;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "AppError";
  }

  static from(payload: unknown): AppError {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      "message" in payload
    ) {
      const p = payload as AppErrorPayload;
      return new AppError(p.code, p.message, p.details);
    }
    return new AppError("unknown", String(payload));
  }
}

/**
 * Typed IPC invoke. All backend commands return Result<T, AppError>;
 * Tauri rejects the promise with the serialized AppError on Err.
 */
export async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    throw AppError.from(e);
  }
}

export interface AppInfo {
  name: string;
  version: string;
  dataDir: string;
  ffmpegVersion: string | null;
}

export const api = {
  appInfo: () => cmd<AppInfo>("app_info"),
  getSettings: () => cmd<Record<string, string>>("get_settings"),
  setSetting: (key: string, value: string) =>
    cmd<void>("set_setting", { key, value }),
};
