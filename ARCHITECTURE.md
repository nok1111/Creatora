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
