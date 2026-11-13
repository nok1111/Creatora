# CHANGELOG.md — Creatora

Format: [Keep a Changelog](https://keepachangelog.com). Versions use SemVer.

## [Unreleased]

### Added
- Phase 0: repository/environment audit, complete documentation set (architecture, DB schema v1, dev plan, ADRs, testing strategy, API capability matrix, licensing audit).
- Decision record set ADR-001…ADR-012 (Tauri 2, two-path media engine, FFmpeg-as-subprocess, `.creatora` format, keyring secrets, loopback OAuth, whisper.cpp, job engine, i18n, Zustand+Query, offline-first).
- Phase 1: app scaffold (Vite 8 + React 18 + TS strict + Tauri 2 + Tailwind 3).
- Phase 1: Creatora design tokens — dark-first navy/charcoal, violet accent, light variant.
- Phase 1: app shell with nav rail; 13 modules routed; honest phase placeholders.
- Phase 1: Rust core — SQLite catalog (rusqlite, WAL), embedded migrations, typed AppError, ffmpeg locator, app_info/settings commands.
- Phase 1: i18n EN/ES (type-checked catalogs); settings persisted to SQLite.
- Phase 1: autosave foundation service (registered dirty sources, interval ticks, error handler) + unit tests.
- Phase 1: CSP meta, ErrorBoundary, sonner error toasts.
- Phase 2: `.creatora` project format v1 — versioned JSON doc (timeline/canvas/tracks/clips/keyframes/subtitles refs), atomic save, autosave + crash-recovery detection, open-time version guard.
- Phase 2: project CRUD commands + catalog sync; New Project dialog with presets; Home recents with favorite/archive/duplicate/delete+recovery prompt.
- Phase 2: job engine (progress events, cancellation, durable rows); FFmpeg provisioned as subprocess tools (9.0.2 GPL build, notices recorded).
- Phase 2: media import pipeline — ffprobe metadata, xxh3 dedup, ffmpeg thumbnails; Library UI with kind filters, search, missing-media detection + relink; integration tests against real ffmpeg.
- Phase 2 (2nd pass): asset favorites (migration 0002), collections CRUD + sidebar, tags (create-on-use), project_asset usage sync on save, drag-drop import, project bundle export with media consolidation + missing-media self-heal on open.
- Phase 3 vertical slice: render engine (`render/plan.rs` → ffmpeg filter_complex, absolute-placement segments per ADR-015; job-driven `export_project` with real progress + kill-on-cancel), timeline engine (`lib/timeline-engine.ts`: immutable ops + frame snapping + preview math mirroring the plan), snapshot undo/redo (ADR-014), editor UI (media bin, DOM compositor preview, timeline with move/trim/split/snap), real-media e2e suite verifying exported output pixels/PCM/duration.
- Phase 3A: track controls (add/delete/rename/lock/hide/mute/reorder), multi-select + clipboard ops, configurable snapping, zoom/nav, keyboard shortcuts — all through snapshot undo.
- Phase 3B: extensible effects pipeline — canonical param registry (CSS/SVG ↔ ffmpeg), brightness/exposure/contrast/saturation/temperature/blur/opacity; keyframes (clip-relative, linear, dual evaluator → ffmpeg expressions); transitions (overlap model → xfade/afade); clip inspector panel.
- Phase 3C: proxy generation job (≤960w mezzanine), proxy/original preview toggle, 3s prefetch window, bounded decoders.
- Phase 3D: commercial validation — 16 real-media e2e + 4 proxy/import tests covering mixed res/FPS, z-order, long projects, 720p, effect/transition/keyframe pixel & PCM checks. ADR-016…019.
- Phase 3E: editor hardening — audit-found fixes (split keyframe remap, orphan transitions, source-bound trim, cross-track transition cleanup, drop-target track, empty-clipboard guard); text tracks (canonical TextStyle + drawtext + DOM preview, pixel-verified); shared keyframe parity vectors TS↔Rust; `delete_proxy` + partial-proxy cleanup; auto preview-quality degradation on sustained over-budget rAF; stress measurements (20×100 plan, 50-clip render).
- Phase 4: multi-format versions (ADR-021/022/023) — canonical FormatVersion model + migration v1→v2, whitelisted per-clip overrides merged for preview AND render identically; preset catalog (16:9/9:16/4:5/1:1 + platform hints + safe zones); cover-fit reframe math matching clipRect; local motion-centroid auto-reframe → editable keyframes; VersionsPanel UI (create/switch/rename/duplicate/reset/delete, compare mode, auto-reframe, batch export); export_versions job batch; e2e: square/vertical pixel-verified reframes, keyframed pan, text-in-vertical, multi-format export, persistence, real motion tracking.
- Phase 4.1: export settings wired end-to-end — validated matrix (codec/preset/container/audio), no silent ignores, per-version encoder choice verified via ffprobe (x264/mp4 vs x265/mkv), extension auto-correct, effective-settings UI row. Per-version text copy + style overrides (Inspector section, undo-safe). Reframe stabilization: EMA smoothing, scene-cut reset, hold-on-exit; fallback semantics documented. Tests: dual-encoder, invalid-combo rejection, text override, static/exit-reentry reframe — 40/40 e2e, 41/41 vitest.

## Phase 5 — Subtitle Studio (ADR-025)
- Local whisper.cpp transcription (job-based, progress+cancel, auto/manual
  language, model picker tiny/base/small with explicit user-gated download).
- Subtitle Studio panel: cue list synced to playhead, inline edit, timecode
  fields, split/merge/duplicate/delete/add, search+replace.
- Timing tools: shift all, speed scale, fix-overlaps, diagnostics
  (short/long/longline/unnatural cps) — review-then-apply, undo-safe.
- Styles: canonical SubtitleStyle (TextStyle + highlight + mode + margins),
  6 presets (Classic/Modern/Bold Social/Minimal/Cinematic/Creator Highlight),
  per-version override; karaoke (\k) + pop modes from real whisper tokens.
- Export: SRT/VTT/ASS (unicode/line-breaks preserved) + libass burn-in in
  the same render plan; independent jobs.
- Preview parity: DOM renders margins/align/word-highlight per same model.
- Tests: 3 new render e2e (pixel-verified burn-in window + karaoke fill +
  serializers), 2 subtitle e2e (JSON parse + real whisper-cli run), 7 cue-ops
  vitest. 80 rust + 48 vitest total green.
