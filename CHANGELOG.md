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
