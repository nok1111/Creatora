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
  exportProject: (projectPath: string, outPath: string, versionId?: string) =>
    cmd<string>("export_project", { projectPath, outPath, versionId }),
  exportVersions: (projectPath: string, outDir: string, versionIds: string[]) =>
    cmd<string[]>("export_versions", { projectPath, outDir, versionIds }),
  analyzeSubject: (path: string, inMs: number, outMs: number, samples = 24) =>
    cmd<string>("analyze_subject", { path, inMs, outMs, samples }),
  previewRenderPlan: (projectPath: string) =>
    cmd<{ ok: boolean; durationMs?: number; segments?: number; hasAudio?: boolean; reason?: string }>(
      "preview_render_plan",
      { projectPath },
    ),

  // Subtitles (ADR-025)
  listModels: () =>
    cmd<{ name: string; sizeBytes: number; present: boolean; tier: string; url: string }[]>(
      "list_models",
    ),
  downloadModel: (name: string) => cmd<string>("download_model", { name }),
  transcribeMedia: (projectPath: string, mediaPath: string, model: string, language?: string) =>
    cmd<string>("transcribe_media", { projectPath, mediaPath, model, language }),
  exportSubtitles: (projectPath: string, outPath: string, format: string, versionId?: string) =>
    cmd<void>("export_subtitles", { projectPath, outPath, format, versionId }),

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

  // ---------- audio studio (ADR-026) ----------
  /** Kicks off a waveform job (or returns null on cache hit). */
  generateWaveform: (path: string, buckets: number) =>
    cmd<string | null>("generate_waveform", { path, buckets }),
  readWaveform: (path: string, buckets: number) =>
    cmd<Waveform | null>("read_waveform", { path, buckets }),
  analyzeLoudness: (path: string) =>
    cmd<Loudness>("analyze_loudness", { path }),
  detectSilence: (path: string, noiseDb: number, minMs: number) =>
    cmd<SilenceRegion[]>("detect_silence", { path, noiseDb, minMs }),
  suggestNormalize: (path: string, targetLufs: number, tpCeiling: number) =>
    cmd<NormalizeSuggestion>("suggest_normalize", { path, targetLufs, tpCeiling }),


  // ---------- graphics studio (ADR-027) ----------
  listTemplates: () => cmd<Template[]>("list_templates"),
  saveTemplate: (template: Template) => cmd<void>("save_template", { template }),
  deleteTemplate: (id: string) => cmd<void>("delete_template", { id }),
  exportTemplate: (id: string, outPath: string) =>
    cmd<void>("export_template", { id, outPath }),
  importTemplate: (path: string) => cmd<Template>("import_template", { path }),
  listBrandKits: () => cmd<import("./project-types").BrandKit[]>("list_brand_kits"),
  saveBrandKit: (kit: import("./project-types").BrandKit) =>
    cmd<void>("save_brand_kit", { kit }),
  deleteBrandKit: (id: string) => cmd<void>("delete_brand_kit", { id }),
  exportBrandKit: (id: string, outPath: string) =>
    cmd<void>("export_brand_kit", { id, outPath }),
  importBrandKit: (path: string) =>
    cmd<import("./project-types").BrandKit>("import_brand_kit", { path }),

  // ---------- social studio (ADR-028) ----------
  listSocialPosts: (opts?: { status?: string; platform?: string; query?: string }) =>
    cmd<import("./social-types").SocialPost[]>("list_social_posts", opts ?? {}),
  getSocialPost: (id: string) =>
    cmd<import("./social-types").SocialPost>("get_social_post", { id }),
  createSocialPost: (input: import("./social-types").PostInput) =>
    cmd<import("./social-types").SocialPost>("create_social_post", { input }),
  updateSocialPost: (id: string, input: import("./social-types").PostInput) =>
    cmd<import("./social-types").SocialPost>("update_social_post", { id, input }),
  deleteSocialPost: (id: string) => cmd<void>("delete_social_post", { id }),
  duplicateSocialPost: (id: string) =>
    cmd<import("./social-types").SocialPost>("duplicate_social_post", { id }),
  upsertPostTarget: (postId: string, input: import("./social-types").TargetInput) =>
    cmd<import("./social-types").SocialPostTarget>("upsert_post_target", { postId, input }),
  deletePostTarget: (id: string) => cmd<void>("delete_post_target", { id }),
  setTargetStatus: (id: string, status: string) =>
    cmd<void>("set_target_status", { id, status }),
  schedulePostTarget: (id: string, scheduledAt: string | null, autoPublish: boolean) =>
    cmd<void>("schedule_post_target", { id, scheduledAt, autoPublish }),
  linkTargetMedia: (targetId: string, assetId: string | null) =>
    cmd<void>("link_target_media", { targetId, assetId }),
  listCaptionTemplates: () =>
    cmd<import("./social-types").CaptionTemplate[]>("list_caption_templates"),
  saveCaptionTemplate: (t: { id?: string; name: string; body: string; hashtags: string[] }) =>
    cmd<string>("save_caption_template", { ...t }),
  deleteCaptionTemplate: (id: string) =>
    cmd<void>("delete_caption_template", { id }),
  listHashtagHistory: (limit?: number) =>
    cmd<string[]>("list_hashtag_history", { limit }),
  listSocialAccounts: () =>
    cmd<import("./social-types").SocialAccount[]>("list_social_accounts"),
  disconnectSocialAccount: (id: string) =>
    cmd<void>("disconnect_social_account", { id }),
  listPublicationAttempts: (targetId: string) =>
    cmd<import("./social-types").PublicationAttempt[]>("list_publication_attempts", { targetId }),
  listScheduled: (from: string, to: string) =>
    cmd<import("./social-types").ScheduledItem[]>("list_scheduled", { from, to }),
  validateSocialPost: (postId: string) =>
    cmd<import("./social-types").ValidationResult>("validate_social_post", { postId }),
  socialOauthBegin: (platform: string, clientId: string) =>
    cmd<{ redirectUri: string; platform: string; scopes: string[] }>(
      "social_oauth_begin", { platform, clientId }),
  publishPostTarget: (targetId: string) =>
    cmd<string>("publish_post_target", { targetId }),
  exportForTarget: (targetId: string, outDir: string) =>
    cmd<string>("export_for_target", { targetId, outDir }),
  platformCapabilities: () =>
    cmd<import("./social-types").PlatformCapability[]>("platform_capabilities"),
  platformRuleset: () =>
    cmd<Record<string, unknown>>("platform_ruleset"),
  saveOauthClient: (platform: string, clientId: string, clientSecret?: string) =>
    cmd<void>("save_oauth_client", { platform, clientId, clientSecret }),
  oauthClientStatus: () =>
    cmd<Record<string, boolean>>("oauth_client_status"),
  revealPath: (path: string) => cmd<void>("reveal_path", { path }),

  generateProxies: (assetIds: string[]) =>
    cmd<string>("generate_proxies", { assetIds }),
  deleteProxy: (assetId: string) =>
    cmd<void>("delete_proxy", { assetId }),
};

export interface Waveform {
  /** min/max pairs per bucket, -1..1 (len = buckets*2) */
  peaks: number[];
  buckets: number;
  durationMs: number;
}

export interface Loudness {
  /** Integrated LUFS */
  integrated: number;
  /** True peak dBTP */
  truePeak: number;
  /** Loudness range LU */
  lra: number;
  /** Gating threshold LUFS */
  threshold: number;
}

export interface SilenceRegion {
  startMs: number;
  endMs: number;
}

export interface NormalizeSuggestion {
  measuredLufs: number;
  truePeakDb: number;
  lraLu: number;
  gainDb: number;
  needsLimiter: boolean;
}

export interface Template {
  id: string;
  name: string;
  category: string;
  clip: import("./project-types").Clip;
  brandKitId?: string | null;
}
