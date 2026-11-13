# DECISIONS.md — Architecture Decision Records

## ADR-001 — Tauri 2 over Electron

**Decision:** Tauri 2 + WebView2.
**Why:** Smaller installer (~10-20MB vs ~150MB), lower memory footprint, Rust core gives safe concurrent media/job handling, OS-provided WebView2 is already installed on target machines (verified: v157). Electron's bundled Chromium provides more consistent codec support, but Windows OS decoders cover H.264/AAC which are our primary formats.
**Consequence:** Preview codec support depends on the OS (H.264 ✓, HEVC depends on installed codecs, VP9/AV1 via Chromium). FFmpeg subprocess covers anything WebView2 can't decode by generating proxies.

## ADR-002 — Preview via WebView2 decode + WebGL compositor; FFmpeg only for export

**Decision:** Two media paths (see ARCHITECTURE.md).
**Why:** Decoding via ffmpeg and shipping frames to the webview burns CPU and IPC bandwidth for no benefit at preview time. HTMLVideoElement gives hardware decode for free. A WebGL2 compositor applies the same parameter model that the Rust render plan consumes for ffmpeg export.
**Risk & mitigation:** Preview/export visual drift. Mitigated by: (a) shared parameter model, (b) Phase 3 acceptance requires frame-diff validation of exports against reference frames, (c) effects implemented only when representable in both GLSL and ffmpeg filter_complex.
**Rejected:** Embedding libmpv/libvlc — adds native packaging complexity and LGPL linkage concerns; a frame-pipe approach as plan B if WebView2 decode proves insufficient.

## ADR-003 — FFmpeg as subprocess (never linked)

**Decision:** All FFmpeg work is `ffmpeg`/`ffprobe` child processes spawned by Rust.
**Why:** Keeps Creatora a separate program from FFmpeg for licensing purposes (see LICENSES_AND_DEPENDENCIES.md), isolates crashes, allows swapping builds, and filter_complex covers our render needs without API bindings.
**Consequence:** Codec/format support is limited by the shipped ffmpeg build's configure flags; build flags recorded in LICENSES_AND_DEPENDENCIES.md and verified by a startup probe (`ffmpeg -version`, `-encoders`).

## ADR-004 — rusqlite over sqlx

**Decision:** `rusqlite` (bundled) behind `Mutex<Connection>`; commands run on Tauri's async runtime with `spawn_blocking` for heavy queries.
**Why:** Catalog queries are short; sqlx adds compile-time complexity and a heavier dep tree for no real gain. Migrations are plain `.sql` files — transparent and diffable.

## ADR-005 — `.creatora` project format: versioned JSON document

**Decision:** A project = a single `.creatora` file containing versioned JSON: `{format_version, meta, timeline, formats, subtitles, brand, exportProfiles}`. Media referenced by path (+hash) — never embedded.
**Why:** Portable, human-inspectable, recoverable, version-controllable. SQLite remains the catalog/index, not the source of truth for project content.
**Migration:** `project/migrations.rs` upgrades `format_version` on open; refuses (with clear error) newer versions.

## ADR-006 — Secrets in OS keychain (Windows Credential Manager)

**Decision:** `keyring` crate; per-account service keys like `creatora/{platform}/{platform_user_id}`.
**Why:** DPAPI-protected, per-Windows-user, survives reinstall, never touches disk plaintext. SQLite stores only account metadata + scopes.

## ADR-007 — OAuth via system browser + loopback redirect

**Decision:** `authorize` opens default browser; localhost listener on ephemeral port catches the code; state+PKCE enforced.
**Why:** Most secure desktop pattern; no embedded-browser cookie leakage; consistent across YouTube/Meta/TikTok.
**Fallback:** Manual code paste for providers that forbid loopback (documented per platform in API_INTEGRATIONS.md).

## ADR-008 — whisper.cpp as local transcription engine

**Decision:** Transcription behind a `TranscriptionEngine` trait; first implementation = whisper.cpp sidecar binary + user-triggered model download (MIT license, no API keys, fully offline).
**Why:** Meets "no mandatory AI subscription" + privacy requirements. Modular so a cloud engine could be added later as *optional*.

## ADR-009 — Job engine for all long work

**Decision:** Single `jobs` module: typed `JobKind` enum, Tokio workers, `CancellationToken`, progress events `job://progress`, durable `jobs` table for crash recovery.
**Why:** One progress/cancel UX everywhere; exports/imports/transcription uniform; interrupted jobs detectable on restart.

## ADR-010 — i18n from day one

**Decision:** `react-i18next` + `i18next` with `en`/`es` catalogs; all strings via `t()`.
**Why:** Retrofitting i18n into a mature UI is costly; requirement mandates EN+ES at launch.

## ADR-011 — State: Zustand + TanStack Query

**Decision:** Zustand for local/editor state (timeline, selection, dirty flags); TanStack Query for backend-fetched data (library, projects, accounts).
**Why:** Minimal boilerplate vs Redux; Query gives caching/invalidation for DB-backed lists; keeps undo/redo scoped to the timeline store only.

## ADR-012 — No mandatory account, no telemetry by default

**Decision:** App works fully offline; any future update-check is opt-in and documented.
**Why:** Commercial promise: local-first, privacy-respecting.
