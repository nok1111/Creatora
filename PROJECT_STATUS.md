# PROJECT_STATUS.md — Creatora

> **This is the authoritative source of truth for development progress.**
> Update at the end of every work session. Verify claims against code, not memory.

## Current state

- **Current phase:** PHASE 3 — vertical slice COMPLETE and verified (import → timeline → preview → trim/move → save/reopen → ffmpeg export). Phase 3 continues with effects/keyframes/transitions/track controls per plan.
- **Current task:** Phase-3 follow-ups (see audit section) or Phase 4
- **Build status:** `npm run build` ✓ · `cargo test` 17+3+7 ✓ · `npm test` 11/11 ✓ · `tsc` clean
- **Next exact action:** Phase 3 continuation — track controls UI (mute/visible/lock), clip name display, playhead-step snapping indicator, then effects pipeline (shared param model → GLSL + ffmpeg).

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

## PHASE 3 — Video Engine & Editor (VERTICAL SLICE COMPLETE — audited 2026-11-13)

### Delivered

- **Render engine** (`src-tauri/src/render/`): `plan.rs` compiles `ProjectDoc` → ffmpeg `filter_complex` using absolute-placement segments (overlay `enable=between` + `adelay`/`amix`) — ADR-015. `commands.rs` runs it through the job engine with real `-progress` parsing and kill-on-cancel (partial output removed).
- **Timeline engine** (`src/lib/timeline-engine.ts`): pure immutable ops — `addClip`/`moveClip`/`trimClip`/`splitClip`/`removeClip`/`updateClip`, frame snapping (`msToFrame`/`frameToMs`/`snapToFrame`/`timecode`), `activeClipsAt`/`clipRect` mirroring the Rust segment math — ADR-013.
- **Editor store** (`src/stores/editor.ts`): document-snapshot undo/redo (cap 100, gesture coalescing via begin/endGesture) — ADR-014. Selection, playhead, zoom.
- **Editor UI** (`src/modules/editor/`): MediaBin (assets, drag/+ to timeline), Preview (per-clip media elements, rAF master clock, drift-corrected seek, volume/mute), TimelinePanel (ruler, tracks, move/edge-trim/split/delete, snap to playhead+edges), EditorPage (save/undo/redo/export header, transport, shortcuts Ctrl+S/Z/Y, Space, S, Del, arrows).
- **Export flow**: save → file dialog → `export_project` job → progress bar → result toast; `skippedClips` reported.
- **i18n**: `editor.*` keys in EN+ES.

### Phase-3 audit (engine-specific, as required)

| Requirement | Status | Evidence |
|---|---|---|
| Shared timeline model preview↔render | ✅ | One `Timeline`/`Clip` doc; Rust `build_plan` + TS `timeline-engine` mirror. `clipRect` formula == `overlay=x:y` — asserted by pixel test. |
| Explicit time/fps/frame model | ✅ | ADR-013: integer ms + frame snapping at ops layer; round-trip tests both sides. |
| A/V sync | ✅ | Structural: same `startMs` drives video gate and `adelay`. RMS-verified delayed-audio test. |
| Non-destructive ops | ✅ | Ops rewrite doc fields only; trim/split adjust `sourceInMs`, never media. |
| Multi-track scalability | ✅ | Track array = z-order; per-clip overlay + amix; no per-track concat. |
| Architectural undo/redo | ✅ | Snapshot stack (ADR-014); total restoration, gesture coalescing. |
| Heavy work off UI thread | ✅ | ffmpeg subprocess in `spawn_blocking` job; `-progress pipe:1`. |
| Render via job engine | ✅ | `render.export` kind, durable job row, progress+finished events. |
| Autosave/persistence kept | ✅ | Unchanged pipeline; save→reopen round-trip test. |
| Proxies/preview quality | ⏳ designed | `proxy_path` plan documented; deferred until a heavy project demands it. |

### Real-media verification (`tests/render_e2e.rs` — 7/7, actual ffmpeg output)

- Trimmed clip exports at the trimmed duration (2.0 s ± 0.15).
- Reordered clips verified by decoded frame pixels (red↔blue swap).
- Transform scale+position verified by frame pixels (left half red / right black).
- Audio delay verified by PCM RMS (silent → tone at clip start).
- Image clip (`-loop` input) renders correct duration + green frame.
- Save → reopen = byte-identical timeline.
- Cancelled render leaves no partial file.

### Known limitations (honest)

- Preview compositor is DOM/CSS, not the WebGL2 compositor of ADR-002 — sufficient for v1; required later for the effects pipeline. CSS `rotate` doesn't expand the layout box like ffmpeg `rotate` → minor preview drift on rotated clips only.
- Preview mounts elements only while active (decode restart at each clip edge); tolerated at v1 clip counts.
- `speed` supported in the render graph (setpts/atempo chain) but no UI control yet.
- No effects/transitions/keyframes, waveforms, clip thumbnails, multi-select, or track mute/visible/lock UI (schema fields exist).
- Text/graphics tracks are skipped by export; `ExportResult.skippedClips` reports the count.
- VFR sources conform to project CFR via the `fps` filter.
- One transient `invoke` error was observed from a non-webview Vite client (external browser tab); the Tauri webview itself is healthy (catalog + IPC verified).

## Known bugs

None blocking. See Phase-3 limitation list.

## Blockers

- Social platform API credentials do not exist yet (Phase 8 concern).
- `scan_missing_assets`/`relink` verified via unit-level DB ops; full UI click-path needs manual check on next launch.

## Latest test results (2026-11-13)

- `cargo test --lib`: **17/17** — incl. render plan graph assertions (enable window, atrim range, adelay, mute/visible handling, transform in graph, args/maps).
- `cargo test --test media_import`: **3/3** real ffprobe/ffmpeg import pipeline.
- `cargo test --test render_e2e`: **7/7** — real exported media verified (duration, order via pixels, transform via pixels, audio delay via PCM RMS, image clip, save/reopen fidelity, cancel cleanup).
- `npm test`: **11/11** (3 autosave + 8 timeline-engine). `tsc --noEmit` clean. `vite build` clean (~495 kB).
- Manual: `tauri dev` launches clean; editor module routed; catalog ready.

## Session log

| Date | Session summary |
|---|---|
| 2026-11-13 | Phase 0: audit + 10 docs committed (f2169b9). |
| 2026-11-13 | Phase 1: app foundation — shell/theme/i18n/settings/SQLite/autosave; verified + committed (4bbef32). |
| 2026-11-13 | Phase 2 partial: `.creatora` format + project CRUD + autosave/recovery + New Project dialog + recents UI; ffmpeg provisioned (9.0.2 GPL); job engine; media import + library UI + missing/relink; integration tests vs real ffmpeg pass. |
| 2026-11-13 | Phase 2 pass 2 (7171df4): favorites, collections/tags, drag-drop import, usage tracking, bundle export + missing-media self-heal. |
| 2026-11-13 | Phase 3 vertical slice: render engine (plan→ffmpeg graph, job-driven export, real progress/cancel), timeline engine + ops, snapshot undo/redo, editor UI (bin/preview/timeline), 7 real-media e2e tests — audited per spec. |
