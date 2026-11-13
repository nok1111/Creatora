# ARCHITECTURE.md — Creatora

## High-level overview

Creatora is a Windows desktop application built on **Tauri 2**:

```
┌──────────────────────────────────────────────────────────┐
│  WebView2 (Chromium)                                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │  React 18 + TypeScript + Tailwind + shadcn/ui      │  │
│  │  • App shell, routing, workspaces                  │  │
│  │  • Timeline UI, preview compositor (WebGL2)        │  │
│  │  • State: Zustand stores + TanStack Query          │  │
│  └───────────────────┬────────────────────────────────┘  │
└──────────────────────┼───────────────────────────────────┘
                       │ Tauri IPC (commands + events)
┌──────────────────────┴───────────────────────────────────┐
│  Rust core (src-tauri)                                   │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐  │
│  │  db/        │ │  jobs/       │ │  media/           │  │
│  │  SQLite     │ │  job engine  │ │  ffmpeg/ffprobe   │  │
│  │  migrations │ │  (progress,  │ │  subprocess,      │  │
│  │  project IO │ │  cancel)     │ │  thumbnails,      │  │
│  └─────────────┘ └──────────────┘ │  proxy gen        │  │
│  ┌─────────────┐ ┌──────────────┐ └───────────────────┘  │
│  │  accounts/  │ │  export/     │ ┌───────────────────┐  │
│  │  OAuth,     │ │  render plan │ │  transcription/   │  │
│  │  keyring    │ │  → ffmpeg    │ │  whisper.cpp      │  │
│  └─────────────┘ └──────────────┘ │  sidecar          │  │
│                                   └───────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Key architectural decisions

(Full reasoning in DECISIONS.md)

1. **FFmpeg is a subprocess, never a linked library.** All decode/encode goes through `ffmpeg`/`ffprobe` child processes spawned by the Rust core. This keeps Creatora's own code license-clean (see LICENSES_AND_DEPENDENCIES.md) and isolates crashes.
2. **Two media paths:**
   - *Preview path*: WebView2 decodes via `<video>` elements (Chromium + OS codecs); a WebGL2 compositor applies transforms/effects in real time. Cheap, hardware-accelerated, zero extra binaries for preview.
   - *Render path*: the Rust core compiles the timeline into an FFmpeg filter_complex render plan and exports. Preview and render share the same clip/effect parameter model (`RenderPlan`), so what you see is what exports.
3. **SQLite catalog + file-based projects.** The app DB (`creatora.db`) catalogs projects, media assets, accounts, publications, analytics cache. Each project is a versioned `.creatora` file (JSON document) so projects are portable, diffable, and recoverable without DB access.
4. **Job engine.** Every long-running task (import, thumbnail, proxy, transcription, export) is a `Job` queued on a Tokio worker pool, emitting `job://progress` events. Jobs are cancellable via `CancellationToken`; unsafe-to-cancel steps are marked.
5. **Secrets in the OS.** OAuth tokens live in Windows Credential Manager via the `keyring` crate — never in SQLite, never in the frontend, never in project files.
6. **Modular adapters.** `platform` trait in Rust per social network (capability matrix-driven). `engine` trait for transcription (whisper.cpp first, local-only).

## Repository layout

```
Creatora/
├── docs files (mandatory *.md at root)
├── src/                    # React frontend
│   ├── app/                # shell, router, providers
│   ├── modules/            # one folder per product module
│   │   ├── home/  library/  editor/  formats/  subtitles/
│   │   ├── audio/  graphics/  brand/  social/  planner/
│   │   ├── analytics/  export/  settings/
│   ├── components/         # shadcn/ui + shared UI
│   ├── design/             # tokens, theme
│   ├── i18n/               # en.json, es.json, loader
│   ├── stores/             # zustand stores
│   └── lib/                # ipc client, types, utils
├── src-tauri/              # Rust core
│   ├── src/
│   │   ├── main.rs / lib.rs
│   │   ├── db/             # connection, migrations, queries
│   │   ├── project/        # .creatora format, autosave, recovery
│   │   ├── jobs/           # job engine
│   │   ├── media/          # ffmpeg, ffprobe, thumbs, proxy
│   │   ├── render/         # render plan → filter_complex
│   │   ├── accounts/       # OAuth + keyring
│   │   ├── platforms/      # youtube/ tiktok/ instagram/ facebook/
│   │   ├── transcription/  # engine trait + whisper.cpp sidecar
│   │   └── settings.rs error.rs logging.rs
│   ├── migrations/         # numbered .sql files
│   └── tauri.conf.json
├── tools/                  # ffmpeg, whisper binaries (provisioned, gitignored)
└── package.json / vite.config.ts / tailwind.config.ts
```

## Audio pipeline (ADR-026)

- Canonical chain per clip: `atrim→atempo→audiofx→volume(+kf)→track
  gain→afade→pan→adelay` → per-track bus; `DuckingRule`s →
  `sidechaincompress` (source `asplit`+`apad`); `amix` → master `alimiter`.
- `render/audiofx.rs` maps the shared `Effect` model to ffmpeg audio
  filters; `src/services/audio-preview.ts` mirrors via WebAudio
  (Biquad/DynamicsCompressor where expressible; analyser-driven ducking).
- Analysis commands (`audio/`): waveform peaks (job + xxh3 disk cache),
  `loudnorm` JSON parse, `silencedetect` → reviewable proposals only.

## Graphics & text compositor (ADR-027)

- **Generated layer per clip.** Every text/graphics clip compiles to a
  transparent `color` source → `drawbox` (shapes) → `drawtext`(s) →
  `scale eval=frame` → `rotate` → `geq` alpha → gated `overlay`. Preview
  uses a canvas-sized wrapper carrying scale/rotation (same pivot), DOM
  span/div for text/shape.
- **Alpha is composed in ONE `geq` pass** — shape coverage
  (`drawbox` cannot write alpha), opacity keyframes and wipe masks all
  multiply/max into `a=`.
- **Animations.** Presets bake eased keyframe samples onto canonical
  transform paths (real in both renderers). Procedural kinds live in
  `Clip.textFx` (typewriter/wipe/blur + `out` variants): implemented as
  gated drawtexts / geq masks / gblur+geq branch fork in render, and as
  prefix-slice / clip-path / CSS-blur dual-div in preview. No
  preview-only animations exist.
- **Version independence.** `ClipOverride` carries transform, keyframes,
  textStyle, text, `hidden`, `textFx` — `apply_version` merges;
  `clearVersionClipOverrides` re-syncs a clip to base.
- **Brand kit.** App-side `app_data/brandkits/*.json` + a snapshot
  embedded in the doc; `Clip.brandBindings` slot indices apply on bind /
  explicit "apply brand" only — never auto-overwrites custom values.
- **Templates.** `app_data/templates/*.json` store a canonical `Clip`
  payload (+ optional `brandKitId`) — applicable to any project,
  import/export as files.
- **Fonts.** `resolve_font`: configured → arial → segoeui → omit
  `fontfile`; missing files degrade instead of killing the render.
- `graphics.rs` owns template/kit file stores (atomic `.part`→rename);
  `anim-presets.ts` is the single preset catalog shared by inspector UI
  and the engine.

## Data flow

- Frontend → backend: typed Tauri commands (`#[tauri::command]`), all return `Result<T, AppError>`; `AppError` serializes to `{code, message, details?}`.
- Backend → frontend: events on topics (`job://progress`, `media://changed`, `autosave://saved`).
- Rendering: timeline JSON → `RenderPlan` → ffmpeg `filter_complex` + inputs → output file. Deterministic and unit-testable on the Rust side.

## Non-negotiable invariants

- The UI thread never runs media work; WebView + Rust worker pool only.
- Nothing writes outside the app's data dir, project dirs, and user-picked export paths.
- Every DB schema change = a new numbered migration; `user_version` pragma tracks state.
- Project format bumps are explicit migrations in `project/migrations.rs`; opening a newer-version project shows a clear "created by a newer Creatora" error, never silent corruption.
- No network calls for editing. Editing works fully offline.

## Editing engine (Phase 3)

- **One timeline model, two consumers.** `Timeline`/`Clip` in the `.creatora` doc is the only representation. The Rust `render::plan` module compiles it to an ffmpeg `filter_complex` graph; the TS `timeline-engine` module compiles the same fields to preview state (active clips at T, per-clip source time, canvas placement). Segment math is mirrored deliberately — `ms → source time → canvas rect` must produce identical results on both sides, and the e2e tests verify the ffmpeg output, not the TS math.
- **Canvas placement parity.** A clip's source is fitted into the canvas preserving aspect ratio (letterbox), then `transform.scaleX/Y` scales that fitted box, `x/y` translate it in canvas pixels, `rotationDeg`/`opacity`/crop fractions apply after. FFmpeg expresses this as `scale → pad → (crop|rotate|alpha) → overlay=x:y`. Preview expresses it as CSS `left/top/width/height` inside a canvas-scaled stage. Same formula, same inputs.
- **Preview transport.** One master clock (`requestAnimationFrame` + `performance.now`); each active media element (`<video>`/`<audio>`) is seeked to `sourceTimeAt(clip, t)` when drift exceeds ~80 ms and `playbackRate` matches `clip.speed`. This is intentionally tolerant — preview favors smoothness; *export* is the source of truth for frame accuracy.
- **Heavy work off the UI thread.** Export runs in the job engine (`spawn_blocking`), spawning ffmpeg with `-progress pipe:1`; progress events report `out_time/duration`. Cancel kills the child process. ffmpeg/JS video decode never runs on the Rust or JS main threads respectively.
- **Proxies:** planned as a `proxy_path` column on `media_assets` + a preview-quality setting; the render plan always uses originals (quality), preview uses proxy when present. Schema hooks land when a real heavy project proves the need.

## Social Studio (Phase 8)

```
src/modules/social/        React: SocialPage (dashboard+list+filters),
                           ComposerDialog, CaptionStudio, ValidationPanel,
                           CalendarView, AccountsPanel, PostDetail
src/stores/social.ts       Zustand: posts, filters, accounts, selection
src/lib/social-types.ts    TS mirrors + extractHashtags (≡ Rust)

src-tauri/src/social/
  model.rs                 SocialPost, PostTarget, SocialAccount, …
  posts.rs                 CRUD commands, scheduling, media link, templates
  rules.rs                 versioned platform ruleset (v1 embedded, vN override)
  validate.rs              validate_social_post → findings + fix links
  vault.rs                 keyring (Windows Credential Manager) tokens+secrets
  oauth.rs                 RFC 8252 loopback + PKCE, refresh, account persist
  publish.rs               publish/export/capability commands + job runners
  scheduler.rs             local 60s tick → auto-publish or social://due event
  platforms/{yt,tt,ig,fb}  real API adapters behind publish() dispatch
```

Data flow: project + version → `export_for_target` (reuses
`run_export_body`) → file imported to Library + linked → optional
`publish_post_target` job → adapter → `platform_post_id` → status
`published`. Every attempt rows into `publication_attempts`.

Status machine (target-level): draft → ready → scheduled → publishing →
published | failed. `scheduled` means "time set"; only auto_publish+account
+file make a publish job actually run — otherwise `social://due` fires and
the UI shows a reminder. Export sets `ready`, never `published`.

## Analytics subsystem (Phase 9)

```
src/social/
  platforms/http.rs      typed HttpError{status,retry_after} + ep() endpoint
                         overrides (Mutex<Vec>, test-only mutation)
  platforms/mock_tests.rs raw-TcpListener mock server (no deps) - 17 tests
  stats/{mod,youtube,tiktok,instagram,facebook}.rs
                         per-platform StatsAdapter -> {metrics[] w/ unit+source,
                         unavailable[] w/ reason}
  analytics.rs           sync engine (freshness cooldown, 401 refresh,
                         429 Retry-After, run/error audit), snapshot queries,
                         compare (only mutually-served metrics), local insights
  import.rs              CSV/JSON parse->preview->match->dedupe->commit (10 MiB cap)
  packets.rs             publish packet builder (hardlink->copy, no dupes)
migrations/0005_analytics.sql
src/modules/analytics/   AnalyticsPage shell + Dashboard, PostStatsDetail,
                         ComparePanel, InsightsPanel, SyncPanel, ImportPanel,
                         PacketsPanel, charts.tsx (SVG, zero deps)
```

Data flow: platform API -> StatsAdapter -> metric_snapshots(source=api)
-> dashboard/compare/insights queries (SQLite, indexed, paginated).
Imported files -> import_batches + snapshots(source=import). Insights read
snapshots + media_assets metadata - fully offline.

Job plumbing: analytics_sync runs through the existing JobManager; the
60 s scheduler tick also checks the auto-sync interval (settings key
`analytics.sync_interval_minutes`, 0=off).
