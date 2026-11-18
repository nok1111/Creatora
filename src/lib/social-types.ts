/** Mirrors src-tauri/src/social/model.rs + validate.rs outputs. */

export type SocialPlatform = "youtube" | "tiktok" | "instagram" | "facebook";
export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
];

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
};

/** Loopback redirect URIs the OAuth listener prefers — mirrors
 *  PREFERRED_PORTS in src-tauri/src/social/oauth.rs. Providers that
 *  require exact redirect-URI registration (TikTok, Meta strict mode)
 *  only need these whitelisted once; a random port is used if all are
 *  busy and the connect toast shows the URI actually bound. */
export const OAUTH_REDIRECT_URIS = [
  "http://127.0.0.1:45812/oauth/callback",
  "http://127.0.0.1:45813/oauth/callback",
  "http://127.0.0.1:45814/oauth/callback",
];

export type PostStatus =
  | "draft"
  | "ready"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed";
export type TargetStatus = PostStatus | "cancelled";

export interface SocialPostTarget {
  id: string;
  postId: string;
  platform: SocialPlatform;
  accountId: string | null;
  versionId: string | null;
  exportAssetId: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string[] | null;
  platformMeta: Record<string, unknown>;
  status: TargetStatus;
  scheduledAt: string | null;
  autoPublish: boolean;
  platformPostId: string | null;
  platformUrl: string | null;
  lastError: string | null;
  publishedAt: string | null;
}

export interface SocialPost {
  id: string;
  projectId: string | null;
  title: string;
  caption: string;
  hashtags: string[];
  thumbnailAssetId: string | null;
  notes: string | null;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
  targets: SocialPostTarget[];
}

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  platformUserId: string;
  displayName: string | null;
  scopes: string[];
  status: "active" | "expired" | "revoked" | "error";
  connectedAt: string;
  tokenExpiresAt: string | null;
}

export interface CaptionTemplate {
  id: string;
  name: string;
  body: string;
  hashtags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicationAttempt {
  id: string;
  targetId: string;
  status: "uploading" | "published" | "failed" | "cancelled";
  platformPostId: string | null;
  platformUrl: string | null;
  error: string | null;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface Finding {
  severity: "error" | "warning" | "recommendation" | "info" | "passed";
  code: string;
  message: string;
  fix: string | null;
  fixAction: string;
  /** Interpolation values for the translated message (`find.<code>`). */
  params?: Record<string, string | number> | null;
}

export interface ValidationResult {
  postId: string;
  rulesVersion: number;
  rulesUpdated: string;
  targets: { targetId: string; platform: string; findings: Finding[] }[];
}

export interface PlatformCapability {
  platform: SocialPlatform;
  oauth: boolean;
  publish: boolean;
  requiresAppReview: boolean;
  requiresHostedMedia: boolean;
  statusNote: string;
}

export interface ScheduledItem {
  targetId: string;
  postId: string;
  platform: SocialPlatform;
  scheduledAt: string;
  status: TargetStatus;
  autoPublish: boolean;
  title: string;
  exportAssetId: string | null;
  accountId: string | null;
}

export interface TargetInput {
  platform: SocialPlatform;
  accountId?: string | null;
  versionId?: string | null;
  title?: string | null;
  caption?: string | null;
  hashtags?: string[] | null;
  platformMeta?: Record<string, unknown>;
  scheduledAt?: string | null;
  autoPublish?: boolean;
}

export interface PostInput {
  projectId?: string | null;
  title?: string;
  caption?: string;
  hashtags?: string[];
  thumbnailAssetId?: string | null;
  notes?: string | null;
  targets?: TargetInput[];
}

/** Extract `#tags` from caption text — mirrors Rust extract_hashtags. */
export function extractHashtags(text: string): string[] {
  return text
    .split(/\s+/)
    .filter((w) => w.startsWith("#") && w.length > 1)
    .map((w) => w.replace(/^#+|[^\w]+$/g, ""))
    .filter(Boolean);
}
