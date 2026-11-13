# PROJECT_STATUS.md — Creatora

> **This is the authoritative source of truth for development progress.**
> Update at the end of every work session. Verify claims against code, not memory.

## Current state

- **Current phase:** PHASE 2 — substantially complete; remaining items noted below are minor/follow-up. PHASE 3 — Video Engine & Editor is next (largest phase).
- **Current task:** Phase 3 design — timeline model already in `.creatora` v1; next is the preview compositor + timeline UI
- **Build status:** `npm run build` ✓ · `cargo check` ✓ · `cargo test` 11+3 ✓ · `npm test` 3/3 ✓
- **Next exact action:** Phase 3 — implement `render/` plan types, timeline store with undo/redo, preview compositor skeleton (HTMLVideoElement + WebGL2), timeline UI v1 (tracks, trim, split, snapping, markers)

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
| FFmpeg | PROVISIONED | 9.0.2 essentials (GPL build) in `tools/bin/` — see LICENSES_AND_DEPENDENCIES.md |
| whisper.cpp | MISSING | Deferred to Phase 5 (Subtitle Studio) |
| pnpm/yarn | absent | npm used as package manager |

### Technical risks identified

1. **FFmpeg licensing** — GPL subprocess approach decided + build provisioned (record: LICENSES_AND_DEPENDENCIES.md). Counsel review flagged before commercial release.
2. **Preview engine performance** — two-tier design documented (WebView2 decode + WebGL2 compositor, Canvas2D fallback), proxy media for large files.
3. **Social API access** — honest capability matrix in API_INTEGRATIONS.md; blocked items marked.
4. **Long export jobs** — job engine implemented (`src-tauri/src/jobs/`), progress events + cancellation + durable job rows.
5. **Project file compatibility** — `.creatora` format v1 + version guard + migration chain in place.

### Phase 0 acceptance criteria — PASSED 2026-11-13

## PHASE 1 — Foundations & Design System (COMPLETE — PASSED 2026-11-13)

Implemented: Vite 8 + React 18 + TS strict + Tauri 2 + Tailwind 3 scaffold; Creatora dark-first design tokens + light variant; app shell with nav rail, 13 modules routed; i18n EN/ES type-checked; SQLite catalog + embedded migrations; typed AppError; settings persistence; autosave service foundation; ErrorBoundary + toasts; CSP; job-friendly architecture.

## PHASE 2 — Projects & Media Library (IN PROGRESS)

### Done & verified

**Projects:**
- `.creatora` format v1: full serde model (meta/canvas/timeline/tracks/clips/transform/keyframes/subtitles/mediaRefs), camelCase JSON, format-version guard rejects newer files, migration chain ready.
- Atomic save (tmp+rename), autosave to `data_dir/autosaves/<id>.creatora`, recovery detection by mtime (nanosecond compare — seconds-based check failed test, fixed).
- Commands: create/open/save/autosave/recover/discard/list/set-flag(favorite,archive)/duplicate/delete(+optional file delete).
- Catalog sync: `projects` rows upsert on create/open/save; `last_opened_at` tracked; default dir `Documents/Creatora/Projects` (setting `project.defaultDir` override).
- Frontend: `useProject` store (doc, dirty, recovery), New Project dialog (6 presets + custom w/h/fps, validation), Home recents list with open/favorite/duplicate/archive/delete(confirm w/ file option), open-project indicator + save, recovery prompt accept/discard, relative timestamps localized.
- Autosave wired: open project registered as autosave source; dirty → autosave every interval.

**Media library:**
- `ffprobe` subprocess → MediaInfo (streams, fps fractions, duration, codecs); kind classification.
- Import job: `import_media` → JobManager (progress `job://progress`, result `job://finished`, cancel via `cancel_job`, durable `jobs` rows, registry self-cleanup).
- Per-file: existing-path dedup, xxh3 content hash → duplicate_of flag, probe, ffmpeg thumbnail (video@1s / image, scaled ≤320px JPEG → `data_dir/thumbs/`).
- Commands: `list_assets` (kind filter + name search), `scan_missing_assets`, `relink_asset`, `delete_asset`.
- Library UI: kind filter chips, search, asset grid w/ thumbnails via asset:// protocol (scope enabled), missing overlay badge, duplicate icon, relink/delete menu, missing banner count, import progress in button, per-file import error toasts.
- Test corpus generated in `tools/test-media/` (720p h264+aac, vertical, mp3, png) — gitignored.

### Also completed in second Phase-2 pass

- Migration 0002: `media_assets.is_favorite`; favorites filter + star toggle in UI.
- Collections: full CRUD commands + sidebar UI (create, click-filter, delete w/ counts); assign via card menu.
- Tags: create-on-use `tag_asset`/`untag_asset`, sidebar list + filter, tag dialog on cards.
- `project_asset` usage refs synced on every `save_project`.
- Drag-drop import via `getCurrentWindow().onDragDropEvent` (drop paths → import job, drop-zone highlight).
- Project bundle export: `export_project_bundle` → `<dest>/<name>-bundle/` with consolidated `media/` copies + `manifest.json`; missing media reported. On `open_project`, missing refs resolve against sibling `media/` (bundle self-heal).
- `list_assets` filters: kind, name query, favoritesOnly, collectionId, tagId.

### Not yet done (Phase 2 follow-ups, non-blocking)

- [ ] Batch operations (multi-select delete/tag/assign)
- [ ] Project thumbnails (auto-generated preview on Home)
- [ ] Zip-compressed bundle (folder bundle works; zip needs `zip` crate — defer until needed)
- [ ] Collection nesting UI (parent_id supported in schema/commands, UI is flat)
- [ ] Import directly into a chosen project (media_refs link on import is manual today)

## Known bugs

None.

## Blockers

- Social platform API credentials do not exist yet (Phase 8 concern).
- `scan_missing_assets`/`relink` verified via unit-level DB ops; full UI click-path needs manual check on next launch.

## Latest test results (2026-11-13)

- `cargo test`: **11/11** — migrations idempotent, doc round-trip/version-guard/missing-sections, atomic save, autosave recovery, filename sanitize, fps parse.
- `cargo test --test media_import`: **3/3** against real tools — ffprobe video metadata (1280×720 h264 ~6s), audio/png classification, import→thumbnail→dedup→missing-error end-to-end.
- `npm test`: 3/3 (autosave). `tsc --noEmit` clean. `vite build` clean (~451 kB). `npm audit`: 0.
- Manual: `tauri dev` launches clean; catalog + migrations verified on disk; ffmpeg detected by `app_info`.

## Session log

| Date | Session summary |
|---|---|
| 2026-11-13 | Phase 0: audit + 10 docs committed (f2169b9). |
| 2026-11-13 | Phase 1: app foundation — shell/theme/i18n/settings/SQLite/autosave; verified + committed (4bbef32). |
| 2026-11-13 | Phase 2 partial: `.creatora` format + project CRUD + autosave/recovery + New Project dialog + recents UI; ffmpeg provisioned (9.0.2 GPL); job engine; media import + library UI + missing/relink; integration tests vs real ffmpeg pass. |
