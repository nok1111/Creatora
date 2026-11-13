# DEVELOPMENT_PLAN.md — Creatora

Phases are gated: a phase is done only when its acceptance criteria are demonstrated and PROJECT_STATUS.md is updated.

## Module dependency map

```
                 ┌────────────┐
                 │ Foundation │ (shell, db, jobs, settings, i18n, logging)
                 └─────┬──────┘
        ┌──────────────┼───────────────────┐
        ▼              ▼                   ▼
   Projects/       Media import        Render plan
   persistence     + Library           (timeline model)
        │              │                   │
        │              ▼                   ▼
        │         Media Library      Video Editor ──► Export engine
        │              │                   │
        │              │      ┌────────────┼──────────────┐
        │              │      ▼            ▼              ▼
        │              │  Multi-format  Subtitles      Audio
        │              │  Studio        Studio        Studio
        │              │      │            │              │
        │              ▼      ▼            ▼              │
        │         Graphics/Thumbnail + Brand Kit          │
        │                                                 │
        ▼                                                 ▼
   Social accounts ─► Planner/Calendar ─► Analytics ◄── Publications
```

Order rationale: nothing works without foundation; library needs import; editor needs the render model; multi-format/subtitles/graphics extend the editor; export needs the render plan; social/calendar/analytics sit on top of publications.

## PHASE 0 — Audit & planning ✅ DONE 2026-11-13

## PHASE 1 — Foundations & design system

**Tasks**
1. Scaffold: Vite + React + TS frontend; Tauri 2 core; Tailwind + shadcn/ui.
2. Design tokens + dark-first theme (light variant for management areas), typography, icon set.
3. App shell: titlebar-friendly layout, sidebar navigation, module routing, command-palette-ready structure.
4. Rust core: `db` (rusqlite + WAL + migrations), `error` (typed AppError), `logging` (file + console), `settings` commands.
5. i18n: react-i18next-style loader, `en`/`es` catalogs, zero hardcoded UI strings.
6. Autosave foundation: dirty-state tracking + debounced save + recovery record (full project save lands in Phase 2).
7. Global error boundary + toast/error surfacing.

**Acceptance criteria**
- `npm run tauri build` (or `tauri dev` compile) succeeds; `npm run build` (tsc + vite) clean.
- App launches to a navigable shell with all module placeholders routed.
- Theme switch works; strings externalized; settings persist across restart.
- DB created with migrations applied; `user_version` correct.
- Structured errors reach the UI as toasts, not silent failures.

## PHASE 2 — Projects & media library

- Project create/open/save-as/duplicate/archive/delete/recover; `.creatora` format v1; autosave + crash recovery.
- Media import (drag-drop + picker), ffprobe metadata extraction, thumbnails, proxy jobs, hash dedup.
- Library UI: grid/list, collections, tags, search/filter, favorites, missing-media detection + relink.
- Project thumbnails + recents; import/export project package.

**Acceptance criteria**: create → edit → save → close → reopen round-trips losslessly; killing the app mid-edit recovers via autosave; deleting a media file on disk flags it missing and relinking restores it.

## PHASE 3 — Video engine & editor

Sub-phased per product review — vertical slice first, then depth, then performance, then commercial validation. No other modules advance until the editor is solid.

- **3A — Editing completeness** ✅ tracks CRUD/lock/hide/mute/reorder; multi-select, multi-move, copy/cut/paste/duplicate; configurable snapping + indicators; zoom/nav/auto-scroll; keyboard shortcuts; architectural undo/redo on every op.
- **3B — Effects & compositor** ✅ canonical param registry (ADR-016) with CSS/SVG↔ffmpeg pairs — brightness/contrast/saturation/exposure/temperature/blur/opacity; transitions via overlap model → xfade/afade (ADR-018); keyframes with shared linear evaluator → ffmpeg expressions (ADR-017); inspector panel.
- **3C — Performance** ✅ proxy generation job + proxy/full preview toggle (ADR-019), 3s prefetch window, preload=auto, bounded active-element set. Deferred: WebGL compositor (DOM/CSS suffices for the current effect set), frame cache, memory watchdog.
- **3D — Commercial validation** ✅ real-media suite: mixed res/FPS normalization, multi-layer z-order, 16-clip long project, 720p export, effect/transition/keyframe pixel & PCM checks.

**Acceptance criteria**: a real project with cuts, overlays, transitions, filters and keyframes plays back and exports matching preview within verified tolerances (16 real-media e2e assertions via decoded pixels/RMS, not mocks).

## PHASE 4 — Multi-format studio

- Format presets (16:9, 9:16, 1:1, 4:5, custom) + per-format override layers in the project model.
- Canvas preview per format, safe zones, reframing tools, blurred/color/custom background fill.
- Derived versions: create/sync/branch from master with explicit conflict handling.
- Smart reframing: heuristic subject tracking (motion/face via OpenCV-sidecar or ffmpeg cropdetect/scenedetect fallback) + keyframed manual correction.

**Acceptance criteria**: one master produces N derived projects; editing master then syncing preserves per-format customizations flagged as overridden; exports of each format are correct.

## PHASE 5 — Subtitle & audio studio ✅ DONE (split as shipped)

> Executed as two phases: Phase 5 = Subtitle Studio (transcription, cue
> editor, burn-in), Phase 6 = Audio Studio (waveforms, mixer, ducking,
> loudness, silence tools). Voice-over recording remains open (below).

- Transcription engine trait + whisper.cpp sidecar (model download manager with progress/cancel).
- Subtitle editor: cues on timeline, split/merge, styling (font/size/color/bg/outline/shadow), word-level karaoke, templates, SRT/VTT import/export, burn-in via subtitles filter + styled ASS.
- Audio: waveforms, volume automation, fades, normalize, EQ, noise reduction (ffmpeg afftdn/anlmdn), ducking, voice-over recording (getUserMedia → file → track).

**Acceptance criteria**: transcription produces timed cues editable and burnable; exported video contains chosen subtitle rendering; audio adjustments audible in export.

## PHASE 6 — Thumbnails, graphics, brand kit ⏳ PARTIAL (executed as Phase 7)

> Executed as Phase 7 = Text & Graphics Studio + Brand Kit (titles,
> shapes, animation presets, templates, brand kits) — the timeline-side
> half of this phase. Still open: standalone **thumbnail designer**
> (canvas → PNG/JPEG/WebP export) — the graphics compositor built for
> Phase 7 is the render substrate for it.

- Canvas-based graphic editor (fabric.js or custom Konva-like layer engine): text/shapes/images/adjustments/layers/templates; export PNG/JPEG/WebP.
- Brand kits CRUD + one-click apply to graphics/subtitle styles/watermarks.

**Acceptance criteria**: produce a 1280×720 thumbnail with text+image+shapes, export valid PNG/JPEG/WebP; brand kit switching re-skins presets.

## PHASE 7 — Export & render engine

- Profile system (codec/bitrate/fps/resolution/container presets per platform), queue, batch + multi-format export, progress/cancel/resume-safe, output validation (ffprobe), history, temp cleanup.
- Hardware encoders where present (NVENC/QSV/AMF) with software fallback; expose in settings.

**Acceptance criteria**: queue of mixed jobs completes; cancel kills ffmpeg cleanly and frees temp space; every output passes ffprobe validation; crash mid-export leaves recoverable state.

## PHASE 8 — Social integrations (per-platform, capability-matrix driven)

- Account connect via system-browser OAuth + loopback redirect; tokens in Credential Manager.
- Adapters: YouTube (upload/metadata/thumbnail/schedule-per-API/analytics), TikTok Content Posting API, Instagram Graph (professional), Facebook Pages video/reels.
- Where review/approval blocks a capability: adapter ships disabled with honest status; export + "publish packet" (video + metadata txt + thumbnail) fallback offered.

**Acceptance criteria**: each wired operation verified against real API/test app OR documented as blocked in API_INTEGRATIONS.md. No simulated publishes — `published` state only from platform confirmation.

## PHASE 9 — Planner & analytics

- Calendar (month/week/day), publication cards per platform-version, drag-drop scheduling (only through confirmed mechanisms), reminders.
- Analytics workspace: metrics per platform with availability flags, filters, comparisons, CSV export.

**Acceptance criteria**: statuses reflect real API states; metrics shown only when API actually returns them; report export works.

## PHASE 10 — Security, performance, reliability audit

- Load tests: 4K sources, 100+ clip projects, large libraries, queue stress; memory profiling.
- Failure drills: kill mid-export, corrupt project file, missing ffmpeg, expired tokens, offline operation.
- Security review: token storage, path traversal on import/package, CSP, dependency audit (`cargo audit`, `npm audit`).

## PHASE 11 — Licensing & distribution

- License manager: perpetual key, offline-capable activation, grace handling; never gates access to user's own projects/media.
- NSIS/MSI installer via Tauri bundler, code-signing story, update mechanism, third-party notices shipped in-app (FFmpeg source offer, whisper.cpp MIT, etc.).

## PHASE 12 — Final QA & release

- Full regression against acceptance criteria of all phases; clean-install test; upgrade + uninstall tests; release notes; USER_GUIDE completion.

## Execution status update (post Phase 8)

- Phase 8 (Social Studio) — **DONE**: model, ruleset, validation,
  captions, calendar, export integration, OAuth+vault, four real
  adapters with honest capability gating. Docs updated; 118 rust +
  67 vitest green.
- Phase 9 candidates: local analytics/insights (publication_attempts +
  platform stats where scopes allow), publish-packet export fallback,
  mocked-HTTP adapter tests, or a perf sprint (bundle code-splitting,
  WebGL compositor).

## Execution status update (post Phase 9)

- Phase 9 (Analytics) — **DONE**: source-aware metric snapshots, four
  stats adapters (honest capability gating), robust sync engine,
  dashboard/detail/compare/insights UI, publish packets, CSV/JSON
  import, 17 mocked-HTTP adapter tests (Phase 8 debt closed).
  141 rust + 70 vitest green.
- Phase 10 candidates: perf sprint (bundle code-splitting, WebGL
  compositor), packaging/installer (MSIX/NSIS), auto-update, license
  activation, public beta hardening.

## Execution status update (post Phase 10)

- Phase 10 (hardening) - **DONE**: CSP, code splitting (-33% initial
  JS), playhead re-render isolation, job sweep, size caps, dep cleanup,
  reports in PHASE_10_AUDIT / _PERFORMANCE_REPORT / _SECURITY_REPORT.
  144 rust + 70 vitest green.
- Phase 11 (distribution): installer (MSIX/NSIS), auto-update, license
  activation for one-time purchase, cargo-audit in CI, CSP dev-mode
  smoke check, real-GPU perf matrix, third-party notices in About.
