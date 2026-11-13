# API_INTEGRATIONS.md — Creatora

> Capability matrix. A capability is marked **verified** only after a real API call succeeded with real credentials. Until then it is **documented** (built from current official docs) or **blocked** (needs app review/approval we cannot self-complete).

## Auth architecture

- OAuth 2.0 authorization-code flow, system browser + loopback redirect + PKCE (ADR-007).
- Tokens in Windows Credential Manager (ADR-006). Scopes recorded per account in `social_accounts.scopes_json`.
- Adapters implemented: `src-tauri/src/social/platforms/{youtube,tiktok,instagram,facebook}.rs` behind `platforms::publish()` dispatch (Phase 8).
- `published` status is only set when the adapter returns a real `platform_post_id` — `publication_attempts` records every call with sanitized error strings (never tokens).

## YouTube (YouTube Data API v3 + YouTube Analytics API)

| Capability | API | Status | Notes |
|---|---|---|---|
| OAuth (loopback+PKCE) | accounts.google.com | documented | Needs Google Cloud project + OAuth consent screen |
| Upload video | `youtube.videos.insert` (resumable) | documented | Quota ~1600 units/upload; daily quota is a real constraint |
| Title/desc/tags/privacy | `youtube.videos.insert/update` | documented | `privacyStatus` incl. `private` + `publishAt` for scheduling |
| Schedule publish | `status.publishAt` | documented | Only on private/unlisted uploads |
| Custom thumbnail | `youtube.thumbnails.set` | documented | Requires verified YouTube account |
| Video status/processing | `videos.list` | documented | |
| Basic analytics | YouTube Analytics API `reports.query` | documented | Requires `yt-analytics.readonly`; channel-owner data only |
| Comments/list | `commentThreads.list` | documented | |

**Blockers:** OAuth consent screen verification for scopes beyond basic (unverified apps show warning screens — acceptable for v1 but documented).

**Implemented (Phase 8):** resumable upload (`videos.insert` → `Location` + chunked PUT), title/description/tags/privacyStatus, thumbnail upload (`thumbnails.set`), token refresh. Publish returns the real video id or a structured error.

## TikTok (TikTok for Developers — Content Posting API)

| Capability | API | Status | Notes |
|---|---|---|---|
| OAuth | `www.tiktok.com/v2/auth/authorize` | documented | Requires approved developer app |
| Video publish (direct/upload to drafts) | `v2/post/publish/video/init/` | **blocked** | Requires app audit + scope approval (`video.publish` / `video.upload`). Unaudited apps can only post to drafts (`FILE_UPLOAD` + `post.publish` draft inbox) and posting is restricted to private `SELF_ONLY` until approved |
| Creator info | `v2/post/publish/creator_info/query/` | documented | |
| Publish status | `v2/post/publish/status/fetch/` | documented | |
| Analytics | `user.info.stats`, video list | documented | Research API is separate and restricted |

**Blockers:** Real app approval by TikTok — cannot be self-completed.

**Implemented (Phase 8):** `v2/post/publish/video/init/` (FILE_UPLOAD) + chunked PUT + `status/fetch` poll. The adapter runs the real flow; without approved `video.publish`/`video.upload` scopes TikTok returns an API error which is surfaced verbatim (target → Failed with the message).

## Instagram (Instagram Graph API / Platform)

| Capability | API | Status | Notes |
|---|---|---|---|
| OAuth (via Facebook Login) | Graph API | documented | Requires Meta app + Business/Creator IG account linked to a Page |
| Reel/media publish | `/{ig-user}/media` + `/media_publish` | documented | 2-step container flow; media must be served from public URL or resumable upload (`rupload`) |
| Caption/location/cover | container params | documented | |
| Insights | `/{ig-user}/insights`, `/media/{id}/insights` | documented | Business/Creator accounts only |
| Scheduling | container `scheduled_publish_time` (Meta Business Suite path) | partial | Graph API supports scheduled publishing for professional accounts — verify in implementation |

**Blockers:** Personal IG accounts unsupported by API — must communicate requirement of Professional account. Meta app review for `instagram_content_publish` beyond test users.

**Implemented (Phase 8):** real container flow (`/{ig-user}/media` → poll → `/media_publish`). **Honest limitation:** the Graph API requires a publicly reachable `video_url`; the app is local-first so pure-local publish returns a structured error explaining the requirement unless the user supplies `hostedUrl` (their own hosting). Never fakes success.

## Facebook (Graph API — Pages)

| Capability | API | Status | Notes |
|---|---|---|---|
| OAuth | Facebook Login for Business | documented | Page-level tokens required for posting |
| Page video upload | `/{page-id}/videos` (resumable for large) | documented | |
| Reels | `/{page-id}/video_reels` | documented | Page reels supported |
| Page insights | `/{page-id}/insights`, video insights | documented | Metric availability varies by page size/age |
| Scheduling | `scheduled_publish_time` param | documented | |

**Blockers:** Meta app review (`pages_manage_posts`, `pages_read_engagement`, video perms) for non-test use.

**Implemented (Phase 8):** resumable Page video upload (`/{page-id}/videos`: start → transfer chunks → finish) with real token. Works today for app roles (dev/test users + owned pages); broader use needs App Review.

## Cross-cutting rules

- `published`/`scheduled` statuses are set ONLY from confirmed API responses (publication row stores `platform_post_id` + `platform_url`).
- Rate limits and quota recorded per adapter; surfaced in UI when hit.
- Missing capability → UI offers "Export publish packet" (video + thumbnail + metadata.txt) instead of pretending.
- Every adapter call logs request/response metadata (never tokens) for audit.
- Unverified capabilities are disabled behind `#[cfg]`-independent runtime flags and labeled "Not connected/unverified" in UI — never silently simulated.

## Re-verification

Platform limits and API contracts change. `platform_rules` is versioned (`platform_rules.v1.json` embedded, `platform_rules.vN.json` in app_data overrides). Rules are recommendations/limits snapshots — re-verify before each release:

## External docs to re-verify

- Google: `developers.google.com/youtube/v3`, `developers.google.com/youtube/analytics`
- TikTok: `developers.tiktok.com/doc/content-posting-api-*`
- Meta: `developers.facebook.com/docs/instagram-platform`, `/docs/graph-api` (video/reels publishing)

## Analytics / statistics endpoints (Phase 9)

| Platform | Endpoint | Scope required | Metrics served |
|---|---|---|---|
| YouTube | youtube/v3/videos?part=statistics | yt-analytics.readonly (owner) or youtube.readonly | viewCount, likeCount, commentCount |
| YouTube | youtubeanalytics/v2/reports | yt-analytics.readonly | views, estimatedMinutesWatched, averageViewDuration, subscribersGained - channel-owner only |
| TikTok | video/query/?fields=... | video.list | like_count, comment_count, share_count, view_count - requires approved video.list scope |
| Instagram | {media-id}/insights?metric=... | instagram_manage_insights + professional account | reach, likes, comments, shares, saved, views (metric set differs by media_type) |
| Facebook | {video-id}/video_insights | pages_read_engagement + page role | total_video_views, total_video_impressions, reactions, comments, shares - names vary per Graph version |

**Not available / caveats**
- YouTube watch-time & retention: Analytics API only, channel-owner only.
- TikTok granular analytics still largely require Research API or in-app
  Creator tools; video.list gives counts only.
- Instagram followers_gained is an account metric, not per-media;
  insights require Business/Creator.
- Facebook video_insights returns 400/empty for non-page-owned media;
  metric deprecations happen per Graph version - re-verify per release.
- No platform exposes per-viewer data - all metrics are aggregates.

Ruleset: platform_rules.v1.json now lists analytics scopes per platform
so OAuth requests them up front.
