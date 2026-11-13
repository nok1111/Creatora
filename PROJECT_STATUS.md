# PROJECT_STATUS.md — Creatora

> **This is the authoritative source of truth for development progress.**
> Update at the end of every work session. Verify claims against code, not memory.

## Current state

- **Current phase:** PHASE 1 — COMPLETE. Next: PHASE 2 — Projects & Media Library
- **Current task:** Phase 2 kickoff — `.creatora` project format + project CRUD
- **Build status:** `npm run build` ✓ · `cargo check` ✓ · `cargo test` 2/2 ✓ · `npm test` 3/3 ✓
- **Next exact action:** Design `src-tauri/src/project/` — format_version 1 document model, project CRUD commands, project creation dialog in Home

## PHASE 0 — Repository Audit (COMPLETE)

### Findings

- Repository was effectively empty: single commit `8de1968` containing only `.gitattributes`.
- No existing code, UI, build config, or dependencies to preserve or migrate.
- Greenfield project. All architecture decisions documented in DECISIONS.md.

### Environment audit (2026-11-13)

| Tool | Status | Version |
|---|---|---|
| Node.js | OK | v24.14.1 |
| npm | OK | 11.11.0 |
| Rust (MSVC) | OK | 1.97.1 stable, `x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | OK | VS 2022 Community, VC tools present |
| WebView2 Runtime | OK | 157.0.4341.46 |
| FFmpeg | MISSING | Not on PATH — see LICENSES_AND_DEPENDENCIES.md §FFmpeg |
| whisper.cpp | MISSING | Deferred to Phase 5 (Subtitle Studio) |
| pnpm/yarn | absent | npm used as package manager |

### Technical risks identified

1. **FFmpeg licensing** — GPL vs LGPL build choice affects commercial distribution. Mitigation: FFmpeg runs as a separate subprocess (never linked); full analysis + redistribution obligations in LICENSES_AND_DEPENDENCIES.md.
2. **Preview engine performance** — Real-time compositing in a WebView2 canvas needs GPU acceleration with CPU fallback. Mitigation: two-tier preview (HTMLVideoElement decode + WebGL2 compositor, Canvas2D fallback), proxy media for large files.
3. **Social API access** — TikTok/Instagram/FB publishing requires app review that cannot be completed autonomously. Mitigation: honest capability matrix in API_INTEGRATIONS.md; build adapter architecture + export-first fallback now, wire OAuth when credentials exist.
4. **Long export jobs** — must be cancellable, resumable where possible, and never block UI. Mitigation: dedicated job engine in Rust with progress events over Tauri channels.
5. **Project file compatibility** — versioned `.creatora` format + SQLite schema migrations from day one (DECISIONS.md ADR-005).

### Phase 0 acceptance criteria

- [x] Repository inspected; existing code identified (none)
- [x] Stack verified against environment
- [x] All 10 mandatory documents created
- [x] Architecture defined (ARCHITECTURE.md)
- [x] Database design created (DATABASE_SCHEMA.md)
- [x] Module dependency map (DEVELOPMENT_PLAN.md §Dependencies)
- [x] Detailed development plan (DEVELOPMENT_PLAN.md)
- [x] Phase acceptance criteria defined per phase (DEVELOPMENT_PLAN.md)

**Phase 0: PASSED — 2026-11-13**

## PHASE 1 — Foundations & Design System (COMPLETE)

### Implemented

- Scaffold: Vite 8 + React 18 + TS strict; Tauri 2 core; Tailwind 3 + shadcn-style tokens; path alias `@/`.
- Design system: Creatora tokens — dark-first navy/charcoal + violet accent, light variant; sidebar token stays dark in both themes; slim scrollbars; Inter/system font stack.
- App shell: left nav rail (icon rail → labeled on wide), all 13 modules routed from single registry (`src/app/nav.ts`); honest `ModulePlaceholder` shows planned phase — no fake UI.
- Home: real `app_info` IPC (version, data dir, ffmpeg probe result — correctly reports missing).
- Settings (real): theme dark/light, language EN/ES, autosave interval — persisted to SQLite via commands.
- Rust core: `Db` (rusqlite + WAL + FK + busy_timeout), embedded ordered migrations (`user_version` tracking), typed `AppError` → serialized `{code,message}`, `media.rs` ffmpeg locator (tools/bin → env → PATH).
- i18n: i18next, `en`/`es` catalogs type-checked to identical shape; language persisted.
- Autosave foundation: `src/services/autosave.ts` — source registry, dirty-check ticks, serial saves, error handler, beforeunload flush; unit-tested.
- Error handling: `AppError` frontend class + `cmd<T>` wrapper; ErrorBoundary; sonner toasts.
- CSP meta on index.html; offline-first (no telemetry, no network calls anywhere).

### Phase 1 acceptance evidence

- [x] Builds: `npm run build` clean (tsc + vite); `cargo check` clean; app binary compiles + links.
- [x] `npm run tauri dev` launched: window opened, log shows `applied migration 0001_init (user_version=1)` + `catalog ready at ...\com.creatora.app`; `creatora.db` file verified on disk.
- [x] Navigation reaches every module placeholder (routed via HashRouter + registry).
- [x] Theme toggle persists (settings table round-trip; `appearance.theme` key).
- [x] Language switch EN↔ES — catalogs type-checked identical shape.
- [x] `cargo test`: 2/2 (migration applies; idempotent re-open). `npm test`: 3/3 (autosave service).
- [x] Structured errors reach UI as toasts (cmd wrapper + sonner; ErrorBoundary for render crashes).
- [x] `npm audit`: 0 vulnerabilities (after upgrading vite→8, vitest→5).

**Phase 1: PASSED — 2026-11-13**

## Pending tasks (Phase 2 — Projects & Media Library)

- [ ] `.creatora` format v1 doc model (Rust serde + TS mirror types) + project migrations
- [ ] Project CRUD commands + create/open dialog + Home recents wired to DB
- [ ] Autosave wiring for open project + crash recovery record
- [ ] Media import (dialog + drag-drop) → ffprobe metadata → media_assets
- [ ] Thumbnail + hash dedup jobs; job engine core (`jobs` module)
- [ ] Library UI: grid, search/filter, collections/tags, missing-media detection + relink
- [ ] Project archive/duplicate/delete-with-confirm/favorite

## Known bugs

None.

## Blockers

- FFmpeg binary must be provisioned before Phase 2 media import works end-to-end (plan in LICENSES_AND_DEPENDENCIES.md; `CREATORA_FFMPEG` env override supported for dev).
- Social platform API credentials do not exist yet; adapters will be built against documented flows and marked `unverified` until real credentials exist (API_INTEGRATIONS.md).

## Latest test results

- `cargo test`: 2 passed (db migrations apply; idempotent).
- `npm test`: 3 passed (autosave dirty-source selection, error handler, unregister).
- `npx tsc --noEmit`: clean. `vite build`: clean (334 kB bundle / 106 kB gzip).
- `npm audit`: 0 vulnerabilities.
- Manual: `tauri dev` launch verified — window + migration log + DB file created.

## Session log

| Date | Session summary |
|---|---|
| 2026-11-13 | Phase 0: audited empty repo + dev machine; wrote all 10 mandatory docs; committed (f2169b9). |
| 2026-11-13 | Phase 1: scaffolded Tauri 2 + React app; shell/nav/theme/i18n/settings/SQLite/autosave foundation; all checks green; live `tauri dev` launch verified. |
