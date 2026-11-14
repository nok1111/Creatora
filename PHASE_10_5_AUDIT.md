# PHASE 10.5 AUDIT — verified against source, not reports

| Item | Reported | Found in source | Verdict |
|---|---|---|---|
| Export Center | Missing | `JobManager` exists (spawn/cancel/events/durable `jobs` table) but `payload_json` is always `'{}'` and there is no `list_jobs` command or UI | Backend: add payload + list command. UI: new page |
| Publication History | Missing | `publication_attempts` + `list_publication_attempts(target_id)` exist (per-target only); PostDetail shows them | Add global query + Social tab |
| Platform Analytics screens | Missing | Dashboard has platform filter + per-platform stats info (`analytics_platform_stats_info`); no dedicated view | Frontend tab per platform reusing real data |
| Follower history | Partial | `fetch_stats` is per-post only; no account-level snapshots exist anywhere | Migration 0006 `account_snapshots` + `fetch_account_stats` per platform where API allows |
| Sync cancel from UI | Backend ready | `analytics_sync` already checks `ctx.is_cancelled()` between targets and writes `status='cancelled'`; `cancel_job` IPC exists; SyncPanel lacks the button and there is no way to find the running job's id | `list_jobs` exposes running sync; UI button. Mid-request abort = documented limitation |
| Contextual suggestions | Missing | Nothing exists; project state (versions, subtitle styles, graphics, targets) is queryable in stores | New store + rule engine + dismissible banner |

## Verified backend facts used

- `jobs(id,kind,payload_json,status,progress,created_at,finished_at)` — durable;
  kinds in use: `render.export`, `social.export`, `social.publish`,
  `media.import`, `media.proxies`, `reframe.analyze`, `analytics.sync`,
  `subtitles.*`.
- `JobManager.spawn(app, kind, body) -> job_id`; `cancel(id)` flips
  AtomicBool; job body observes via `ctx.is_cancelled()`; finish event
  emits `job://finished` with done/failed/cancelled.
- `publication_attempts` has status CHECK in
  (uploading,published,failed,cancelled), error, remote id, timestamps.
- Account-level stats officially available: YouTube
  `channels.list?part=statistics&mine=true` (subscriberCount/viewCount),
  TikTok `user.info` (follower_count — scope user.info.basic),
  Instagram `/{ig-user}?fields=followers_count` (professional),
  Facebook Page `/{page}?fields=followers_count` (pages_read_engagement).
