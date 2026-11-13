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

  // Projects
  listProjects: (includeArchived = false) =>
    cmd<import("./project-types").ProjectSummary[]>("list_projects", {
      includeArchived,
    }),
  createProject: (opts: {
    name: string;
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
  }) => cmd<import("./project-types").OpenProjectResult>("create_project", opts),
  openProject: (path: string) =>
    cmd<import("./project-types").OpenProjectResult>("open_project", { path }),
  saveProject: (path: string, doc: import("./project-types").ProjectDoc) =>
    cmd<void>("save_project", { path, doc }),
  autosaveProject: (doc: import("./project-types").ProjectDoc) =>
    cmd<void>("autosave_project", { doc }),
  recoverProject: (projectId: string) =>
    cmd<import("./project-types").ProjectDoc>("recover_project", { projectId }),
  discardRecovery: (projectId: string) =>
    cmd<void>("discard_recovery", { projectId }),
  setProjectFlag: (
    id: string,
    flags: { favorite?: boolean; archived?: boolean },
  ) => cmd<void>("set_project_flag", { id, ...flags }),
  duplicateProject: (id: string) =>
    cmd<import("./project-types").OpenProjectResult>("duplicate_project", { id }),
  deleteProject: (id: string, deleteFile: boolean) =>
    cmd<void>("delete_project", { id, deleteFile }),
  exportProjectBundle: (id: string, destDir: string) =>
    cmd<{ bundleDir: string; mediaCopied: number; mediaMissing: string[] }>(
      "export_project_bundle",
      { id, destDir },
    ),

  // Render
  exportProject: (projectPath: string, outPath: string) =>
    cmd<string>("export_project", { projectPath, outPath }),
  previewRenderPlan: (projectPath: string) =>
    cmd<{ ok: boolean; durationMs?: number; segments?: number; hasAudio?: boolean; reason?: string }>(
      "preview_render_plan",
      { projectPath },
    ),

  // Media
  importMedia: (paths: string[]) => cmd<string>("import_media", { paths }),
  cancelJob: (jobId: string) => cmd<boolean>("cancel_job", { jobId }),
  listAssets: (opts?: {
    kind?: string;
    query?: string;
    favoritesOnly?: boolean;
    collectionId?: string;
    tagId?: string;
  }) => cmd<import("./media-types").AssetSummary[]>("list_assets", opts ?? {}),
  scanMissingAssets: () => cmd<number>("scan_missing_assets"),
  relinkAsset: (id: string, newPath: string) =>
    cmd<void>("relink_asset", { id, newPath }),
  deleteAsset: (id: string) => cmd<void>("delete_asset", { id }),
  setAssetFavorite: (id: string, favorite: boolean) =>
    cmd<void>("set_asset_favorite", { id, favorite }),

  // Collections & tags
  listCollections: () =>
    cmd<import("./media-types").CollectionSummary[]>("list_collections"),
  createCollection: (name: string, parentId?: string) =>
    cmd<string>("create_collection", { name, parentId }),
  deleteCollection: (id: string) => cmd<void>("delete_collection", { id }),
  assignToCollection: (assetId: string, collectionId: string) =>
    cmd<void>("assign_asset_to_collection", { assetId, collectionId }),
  removeFromCollection: (assetId: string, collectionId: string) =>
    cmd<void>("remove_asset_from_collection", { assetId, collectionId }),
  listTags: () => cmd<import("./media-types").TagSummary[]>("list_tags"),
  tagAsset: (assetId: string, tag: string) =>
    cmd<void>("tag_asset", { assetId, tag }),
  untagAsset: (assetId: string, tagId: string) =>
    cmd<void>("untag_asset", { assetId, tagId }),
  generateProxies: (assetIds: string[]) =>
    cmd<string>("generate_proxies", { assetIds }),
};
