# PHASE 10.5 REPORT — Product Completeness & Functional Gaps

Commit: see `git log -1` — the Phase 10.5A commit.

## 1. Global Export Center

- **Original status:** exports launched inline from Editor/Social; jobs persisted
  but invisible (`payload_json` was `'{}'`, no listing command, no UI).
- **Changes:**
  - `JobManager::spawn` now persists a payload (project/target/output metadata)
    into `jobs.payload_json` — export jobs carry `projectName`, `outputPath`,
    `targetId`, `platform`, `retryable`.
  - New command `list_jobs(kindPrefix, limit)` + IPC `api.listJobs`.
  - New page `src/modules/exports/ExportsPage.tsx` at `/exports`, nav entry
    "Exports" (EN/ES). Lists all jobs with kind/type filter tabs
    (all/exports/running/failed), progress bars, start/finish timestamps,
    cancel (running), retry (`exportForTarget` for retryable social exports),
    "show in folder" via `reveal_path`. Live refresh on `job://finished`.
- **Same JobManager** — no second job system; the view reads the durable
  `jobs` table + in-flight events.
- **Files:** `src-tauri/src/jobs/mod.rs`, `src-tauri/src/media/commands.rs`
  (`list_jobs`), `src-tauri/src/social/publish.rs` (payload), ExportsPage,
  nav/App/i18n, `src/lib/ipc.ts`.
- **Limitation:** `render.export` retry is not offered (original export spec
  is not stored in the payload — only social.target exports are retryable;
  the button is hidden otherwise).

## 2. Global Publication History

- **Original status:** `publication_attempts` + per-target listing only.
- **Changes:** command `publication_history(platform, outcome, since, limit)`
  joining attempts→targets→posts (post title + project_id); new Social tab
  "History" (`PublicationHistory.tsx`) with platform/outcome/date filters,
  status icons, remote post id + URL link, error text, and "Open" → PostDetail.
- **State machine preserved:** attempt status comes verbatim from the table —
  `uploading`, `published`, `failed`, `cancelled`. Nothing is inferred.
- **Files:** `src-tauri/src/social/posts.rs`, `src-tauri/src/lib.rs`,
  `src/modules/social/PublicationHistory.tsx`, SocialPage.

## 3. Platform-specific Analytics

- **Original status:** one dashboard + platform filter; no dedicated views.
- **Changes:** new "Platforms" tab in Analytics (`PlatformView.tsx`):
  platform switcher (YouTube/TikTok/Instagram/Facebook), 7/28/90-day window,
  account-metrics card with provenance badges + history chart,
  capability note per platform, top posts sorted by real views with "—" for
  missing metrics (never zero), unavailable-metrics summary, per-post detail
  link. No cross-platform aggregation — each view queries
  `analyticsDashboard(days, platform)` only.
- **Files:** `src/modules/analytics/PlatformView.tsx`, AnalyticsPage.

## 4. Follower/subscriber history

- **Original status:** per-post metrics only; no account-level data anywhere.
- **Changes:**
  - Migration `0006_account_snapshots.sql` (registered): account_id →
    social_accounts, platform, source (api/import), metrics_json, fetched_at;
    unique per (account, source, day).
  - `fetch_account_stats` per adapter: YouTube `channels.list?mine=true`
    (subscriberCount, viewCount, videoCount), TikTok `user.info`
    (follower/following counts — needs user.info.basic scope), Instagram
    `/{ig-user}?fields=followers_count,media_count` (professional accts),
    Facebook `/{page}?fields=followers_count,fan_count` (Page token).
  - Sync captures one snapshot per connected account per run
    (`INSERT OR IGNORE` → one per day), errors logged to `analytics_sync_errors`.
  - Command `analytics_account_history(platform)` + UI card/chart in
    PlatformView. Charts render only with ≥2 real snapshots; zero history is
    shown as "no snapshots", never fabricated.
- **Limitations (official APIs):**
  - YouTube gives *current* totals only; history accumulates from first sync.
  - TikTok followers need approved scope; if absent the metric is skipped.
  - Instagram followers require a professional account + pages_read_engagement.
  - Facebook metrics are Page-level only (personal profiles unsupported).

## 5. Sync cancellation from UI

- **Original status:** backend `cancel_job` worked; sync checked
  `is_cancelled()` between targets and persisted `cancelled`; no UI.
- **Changes:** SyncPanel tracks the returned job id, shows a Cancel button
  while running, calls `cancel_job`, shows "Cancelling…" toast and a neutral
  "Sync cancelled" on the `job://finished` cancelled event; run status in DB
  stays `cancelled` (backend writes it before returning Err).
- **Limitation:** an in-flight HTTP request is not aborted mid-call — the
  flag is observed between targets/requests (documented in ARCHITECTURE.md).

## 6. Contextual next-step suggestions

- **Original status:** none.
- **Changes:** `src/services/suggestions.ts` — pure `evalSuggestions(ctx)`
  rule engine (export→vertical, subtitles→style, thumbnail→post,
  multi-format→publish) fed by real state: `listJobs` recent exports,
  project doc (versions' canvas aspect, subtitle cues + styleId, mediaRefs
  image paths), social posts presence. Dismissals persist in localStorage;
  max 2 suggestions; `SuggestionBanner` is a slim dismissible strip at the
  top of the Editor — no popups, no forced flow.

## 7. Tests

- `src-tauri/tests/phase10_5.rs` — 3 integration tests: account_snapshots
  schema/dedupe, publication_history joins+all filters, list_jobs kind filter.
- `src/services/suggestions.test.ts` — 8 tests: each suggestion's condition,
  "already done → not suggested", 2-suggestion cap, dismissal persistence.
- Totals: **147 Rust tests, 78 vitest** — all green; clippy 0 warnings,
  fmt clean, tsc clean, vite build clean (ExportsPage lazy chunk added).

## 8. Remaining limitations

- Mid-request cancel latency for analytics sync.
- `render.export` retry unavailable (see §1).
- Account history starts accumulating at first sync — no backfill possible
  (APIs return current totals only).
- Instagram/TikTok account metrics depend on account type/scopes — skipped
  silently when the API omits them, surfaced in the capability note.
