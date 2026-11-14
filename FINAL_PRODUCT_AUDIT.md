# FINAL_PRODUCT_AUDIT.md — Creatora

> Phase 4 audit, performed against the live app (dev build + real DB + real FFmpeg)
> at 1280×720, 1366×768 and 1920×1080, EN and ES. Findings only — no code changed.
>
> Method: code review of `src-tauri/src`, `src/modules`, `src/services`; live
> click-through of every module; DB inspection of `jobs`, `media_assets`,
> `social_posts`; config review of `tauri.conf.json` + capabilities.

---

## CRITICAL — data loss / broken functionality

### C1. Failed-job error is never persisted — Export Center can't explain failures
- **Module:** Export Center / JobManager (`src-tauri/src/jobs/mod.rs`)
- **Observed:** The `jobs` table has no error column. `spawn_with_payload` runs
  `UPDATE jobs SET status=?, progress=1.0, finished_at=...` and drops the
  `FinishedEvent.error` string. `JobManager::list()` therefore never returns an
  error. In the UI, four real failed exports show only `Failed` — no cause,
  after reload or if the `job://finished` event is missed, forever.
- **Reproduce:** Run any export that fails (e.g. unwritable path). The toast in
  ExportDialog shows the error once; the Export Center row shows nothing and
  there is no way to recover it.
- **Impact:** A user whose export fails at 95% gets "Failed" and nothing else.
  This directly contradicts "the error must be recoverable from the persistent
  job log" (known backlog #1) and is the single biggest trust problem in the
  export flow.
- **Fix:** Add `error TEXT` column to `jobs` (migration `000X`), persist
  `evt.error` on finish, return it from `list()`, render it in the row
  (tooltip/expandable) + surface in a "View error" action.
- **Priority:** P0.

---

## HIGH — important UX / behavior problems

### H1. Auto-subtitles are unreachable: model download has no UI
- **Module:** Editor → Subtitles (`SubtitlesPanel.tsx`, `ipc.ts:114`)
- **Observed:** `api.downloadModel` exists but is never called from any
  component. The Transcribe panel warns "No model installed — download one
  (78 MB+) first" — with no download button/link — and "Transcribe locally"
  stays **enabled** (`disabled={!!job}` only), so clicking it just fails.
- **Reproduce:** Fresh install → Subtitles tab → Transcribe locally → error.
- **Impact:** One of the product's headline features (local captions) is
  effectively dead on arrival. The guided suggestion "Caption it" actively
  walks users into a dead end.
- **Fix:** Inline "Download model" button (job-driven, progress shown) in the
  Transcribe box; disable Transcribe until a model is `present`; reuse the
  existing job system so download progress/cancel/errors are consistent.
- **Priority:** P0.

### H2. Large parts of the UI ignore the EN/ES language setting
- **Module:** Global — ~36 of 49 `.tsx` files never call `useTranslation`.
  Confirmed hardcoded English: `ExportsPage` (title, subtitle, all column
  headers, filter labels, EmptyState, KIND_LABEL/STATUS labels, button
  titles), Social `CalendarView`, `PublicationHistory`, parts of
  `ComposerDialog`, `analytics/*` panels, `GraphicsBin`, `SubtitlesPanel`
  tools (Transcribe/Timing blocks).
- **Reproduce:** Settings → Español → visit Exports/Social/Analytics —
  headers, table columns and helper text remain in English.
- **Impact:** The app advertises a language switch that silently covers only
  part of the product — a visible half-finished feel for ES users.
- **Fix:** Mechanical extraction of the remaining strings into the typed
  catalogs (`en.ts`/`es.ts`); add a CI-style lint or unit test asserting no
  literal user-facing strings in `modules/` (already partially enforced by
  typed keys).
- **Priority:** P1.

### H3. Asset protocol scope is `**` — the webview can read any file on disk
- **Module:** Security (`src-tauri/tauri.conf.json` → `assetProtocol.scope`)
- **Observed:** `scope: ["**"]` means any `asset://localhost/<abs path>` URL
  served to the webview can read arbitrary user files (documents, keys,
  browser profiles) if anything injects a crafted path.
- **Reproduce:** `convertFileSrc("C:/Users/<me>/Documents/secret.docx")`
  resolves through the protocol with no scope error.
- **Impact:** One XSS/injection away from full file read. Known backlog #6.
- **Fix:** Narrow scope to real needs: app-data dirs + media roots the user
  explicitly imported. Options: (a) register directories into the fs/asset
  scope at import time (`scope.allow_directory`), (b) proxy through a custom
  `media://` command that validates the path is a registered media asset
  instead of raw `asset:` for library files. Keep `asset:` for thumbnails
  under app-data only.
- **Priority:** P1 (design decision needed — trade-off vs. arbitrary user
  media paths).

### H4. GPL/third-party notices won't ship in the installer
- **Module:** Packaging / legal (`tauri.conf.json`, `tools/THIRD_PARTY_NOTICES`)
- **Observed:** `LICENSES_AND_DEPENDENCIES.md` commits to shipping GPL notice
  + source offer for the bundled GPL ffmpeg — but `tauri.conf.json` has **no
  `bundle.resources` entry**, so `tools/THIRD_PARTY_NOTICES/` is not copied
  into the package, and Settings → About shows only a raw ffmpeg version
  string with no notices/licence link.
- **Reproduce:** Inspect `tauri.conf.json` — no `bundle.resources`; Settings
  page has no notices UI.
- **Impact:** Commercial release would ship a GPL binary without the required
  notice/offer — the exact obligation the license doc says must be met.
- **Fix:** Add `bundle.resources` for `tools/THIRD_PARTY_NOTICES/**`; add an
  About → "Third-party notices" section/dialog listing ffmpeg build, license
  and source URL (data already in LICENSES_AND_DEPENDENCIES.md).
- **Priority:** P1.

---

## MEDIUM — inconsistencies and frequent friction

### M1. Failed/cancelled jobs are stamped `progress = 1.0`
- **Module:** `src-tauri/src/jobs/mod.rs:173` — the finish UPDATE forces
  `progress=1.0` for every terminal status. A job that died at 40% renders a
  full bar in Export Center → looks "done" at a glance.
- **Fix:** Persist last reported progress instead of forcing 1.0 (keep 1.0
  only for `done`), or hide the bar for failed/cancelled.
- **Priority:** P2.

### M2. Raw technical errors reach users in 13 places
- **Module:** Global (`toast.error(String(e))` ×13 vs `t()` ×16) — e.g.
  `VersionsPanel`, `ExportsPage.retry`, `EditorPage`. Tauri `AppError`/IO
  strings ("Acceso denegado. (os error 5)", ffmpeg stderr tail) are shown raw.
- **Impact:** Non-technical creators see intimidating error text; sometimes
  that's the right detail (we kept it in the switch-guard dialog on purpose),
  but most toasts should say what happened + what to do.
- **Fix:** Small `describeError(e)` mapper → friendly title + raw detail in
  `description`. Apply to the highest-traffic paths (export, import, publish,
  project save) rather than everywhere.
- **Priority:** P2.

### M3. Orphaned files: deleting an asset leaves thumbnail/proxy on disk
- **Module:** `src-tauri/src/media/commands.rs:492` `delete_asset` only
  deletes the DB row; `thumbs/<id>.jpg` and `proxy_path` files stay forever.
  Same for projects: thumbs/autosaves of deleted projects linger.
- **Impact:** Slow cache growth (backlog #5). Small per file, unbounded over
  a product lifetime.
- **Fix:** Delete the thumbnail + proxy file in `delete_asset`; add a startup
  sweep removing thumbs/proxies whose asset id no longer exists (cheap,
  bounded — one `readdir` + set difference).
- **Priority:** P2.

### M4. Export Center shows raw SQL timestamps
- **Module:** `ExportsPage.tsx` — `j.createdAt`/`finishedAt` render as
  `2026-11-14 04:13:54`, not localized or relative.
- **Fix:** `Intl.DateTimeFormat(locale, {dateStyle:'short', timeStyle:'short'})`
  or the existing "x minutes ago" helper used on Home.
- **Priority:** P3.

### M5. Icon-only actions rely on `title` tooltips only
- **Module:** Export Center row actions, timeline track controls — `title`
  attributes (English-only) but no `aria-label`. Screen readers/keyboard users
  get poor targets.
- **Fix:** `aria-label` from i18n on icon-only buttons (same key as title).
- **Priority:** P3.

### M6. Missing-media affordance is split
- **Module:** `MediaBin` shows a "missing" badge but no relink action; relink
  exists only in Media Library (`LibraryPage`). A user inside the Editor with
  a moved file must leave the editor, find Library, relink, return.
- **Fix:** Click the missing badge → native file picker → `relinkAsset` (the
  IPC + flow already exist).
- **Priority:** P2 — real workflow friction, small change.

### M7. Non-uniform animated scale approximated via zoompan
- **Module:** Render (`plan.rs`/`keyframes.rs`) — known limitation from the
  Phase-2 fix: separate scaleX/scaleY keyframes are averaged into zoompan's
  single `z` channel.
- **Impact:** Only affects hand-authored per-axis keyframes; built-in presets
  are uniform and render correctly.
- **Fix options:** (a) document the limitation in the inspector ("uniform
  scale only for animated scale"), (b) render the layer to a fixed canvas and
  apply a second `scale` pass with eval=init per keyframe segment — heavier.
  Recommend (a) now, revisit if users hit it.
- **Priority:** P3.

### M8. Raw ffmpeg version string in Settings → About
- **Module:** `SettingsPage` — shows the full `ffmpeg version 9.0.2-…` line,
  wrapping awkwardly; plus a bare "Retry" button.
- **Fix:** Parse to `ffmpeg 9.0.2 (gyan.dev essentials)` + tooltip/subtitle
  with full string.
- **Priority:** P3.

---

## LOW — polish details

- **L1. Timeline renders every clip unconditionally** (`TimelinePanel` maps
  all tracks/clips). Fine for normal projects; on very large timelines this
  will degrade. Flag as perf risk — **measure before optimizing** (no
  virtualization until data shows it matters).
- **L2. Graphics multi-selection has no group transform** (backlog #3):
  `selection: string[]` exists, but GraphicsInspector edits one element at a
  time. Useful, not blocking — larger feature, keep out of polish scope or
  schedule separately.
- **L3. `+ New format` preset picker** could not be driven by synthetic DOM
  click (Radix pointer-events) — verify manually once; likely fine.
- **L4. One test artifact in the DB:** an export job whose `outputPath` was
  stored mangled (`C:\Users okturno…`) displays a broken path — data from a
  manual probe, not a product bug. Optionally sanitize `outputPath` display
  with `basename` fallback.
- **L5. Subtitles tool column is dense at 1280px** — 10px text/controls are
  small but consistent with the "compact studio" pattern; acceptable.
- **L6. Home "unsaved" label** on the open-project bar uses the word
  "unsaved" even when the dirty flag came from an internal state change —
  cosmetic, fine.

---

## What already looks solid (no action)

- Active-project chip: correct on all routes, dirty dot, responsive (P3 fix
  verified at 800–1920px).
- Project-switch protection: cancel / save / autosave-failure paths verified
  live, EN+ES.
- Empty states: Editor, Exports, Analytics, Subtitles, Social all have real
  EmptyStates with next-step actions.
- Missing-media: DB sweep + `missing` status + relink IPC all exist.
- Keyboard: Ctrl+S/Z/Y/C/X/V/D/A, Space, Delete, arrows in the editor;
  Escape closes Radix dialogs; focus-visible rings on Button/Input.
- Job cancellation is real (atomic flag polled by workers).
- CSP is sane apart from the `**` asset scope.
- Autosave serialized + failure-aware (Phase 3D).
- FFmpeg subprocess boundary: correct (no linking); license risk documented.

---

## Prioritized fix list

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 1 | C1 Job error persistence + error in Export Center | Critical | S |
| 2 | H1 Whisper model download in Transcribe panel | High | S |
| 3 | H4 Ship notices: `bundle.resources` + About notices | High | S |
| 4 | H2 i18n coverage (Exports, Social, Analytics, Subtitles tools) | High | M |
| 5 | H3 Asset protocol scope tightening | High | M (design) |
| 6 | M6 Relink from MediaBin missing badge | Medium | S |
| 7 | M2 Friendly error mapper on top paths | Medium | S |
| 8 | M1 Don't force progress=1.0 on failed jobs | Medium | S |
| 9 | M3 Delete thumbnails/proxies on asset delete + startup sweep | Medium | S |
| 10 | M4 Localized timestamps in Export Center | Medium | S |
| 11 | M5 aria-labels on icon-only buttons | Medium | S |
| 12 | M7 Document uniform-scale limitation | Medium | S |
| 13 | M8 Clean ffmpeg version in About | Low | S |
| 14 | L1/L2 Perf measurement, group transform | Low | L (separate) |

## Technical risks

- **jobs migration:** adding `error` column needs a numbered migration —
  safe, additive, no data rewrite; `list()` must handle NULL.
- **Asset scope:** tightening `**` can break playback of media outside
  approved roots if we restrict too aggressively — implement behind a
  path-validation proxy (`media:` command or per-dir allow-list registered
  at import) and re-verify preview, proxy playback, thumbnails and export
  (ffmpeg reads files directly, unaffected).
- **i18n extraction:** mechanical but touches many files — verify ES
  rendering on every touched screen (overflow risk: Spanish strings are
  longer; check 1366×768).
- **Model download:** requires a real URL for whisper.cpp ggml models
  (huggingface) + SHA check + offline failure path. The download job must be
  cancellable and resumable-safe (write `.part` → rename).

## Proposed implementation groups (small commits each)

**Group 1 — Export truth:** C1 (error column + persist + UI) + M1 + M4 + M5.
Tests: failing export → row shows real error after reload; progress bar
honest; ES/EN.

**Group 2 — Captions unblocked:** H1 (download button as job, disable logic,
offline error) + L3 verify.
Tests: no-model state → download → transcribe on a short clip (tiny model);
cancel; no-network error message.

**Group 3 — Language & notices:** H2 (extract remaining strings) + H4
(resources + About notices) + M8.
Tests: full UI pass in ES at 1366×768 — no visible English; packaged build
contains notices dir.

**Group 4 — Security & hygiene:** H3 (scope/proxy) + M3 (file cleanup +
sweep) + M6 (relink from MediaBin).
Tests: preview/proxy/thumb/export still work with restricted scope; delete
asset removes files; orphan sweep removes strays; relink restores missing
media in editor.

**Group 5 — Error voice + leftovers:** M2 mapper on export/import/publish/
save paths + M7 doc note.
Tests: force read-only save → friendly message + technical detail; ffmpeg
failure shows parsed reason.

**Deferred:** L1 perf virtualization (needs measurements), L2 group
transform (feature work, separate phase).

Per the phase rules: **implementation waits for your approval** of this
audit and the group plan.
