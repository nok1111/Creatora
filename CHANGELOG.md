# CHANGELOG.md — Creatora

Format: [Keep a Changelog](https://keepachangelog.com). Versions use SemVer.

## [Unreleased]

### Added — Phase 7: Text & Graphics Studio + Brand Kit
- Generated-layer compositor (ADR-027): every text/graphics clip compiles to
  a transparent `color` source → `drawbox` (shapes) → `drawtext`(s) →
  keyframed `scale`/`rotate` → single `geq` alpha pass → gated overlay.
- `Clip.shape` (rect/line, fill+outline in canvas px), `Clip.textFx`
  (typewriter | wipe | blur with `out` exit variants), `Clip.hidden`,
  `Clip.brandBindings` — all `serde(default)` back-compatible.
- `TextStyle.shadowColor/X/Y` and `TextStyle.lineSpacingPx` — real on both
  renderers (drawtext shadowcolor/line_spacing ↔ CSS text-shadow/line-height).
- Animation preset catalog (`anim-presets.ts`): entrances, exits, emphasis,
  transitions (in+out combos), continuous — keyframe presets bake eased
  samples; procedural kinds render via gated drawtexts / geq masks /
  gblur+geq branch fork. Nothing is preview-only.
- `ClipOverride.hidden` + `ClipOverride.textFx` — per-version visibility and
  animation, merged by `apply_version` on BOTH sides; `clearVersionClipOverrides`
  re-syncs a clip to the shared base (re-sync button in the inspector).
- Templates: canonical `Clip` JSON under `app_data/templates/*.json` —
  save-from-selection with category, apply with text-replace prompt,
  duplicate, delete, hover preview, import/export.
- Brand Kit: `app_data/brandkits/*.json` store (multiple kits, colors,
  fonts, logos, title style); doc embeds a snapshot; per-clip slot
  bindings apply on bind / explicit "apply brand" — unbinding keeps
  values, custom fields are never overwritten; import/export; logo
  insert imports the file and drops an image clip at playhead.
- Preview: direct drag of text/shape elements (version-aware writes),
  shadow/line-spacing parity, blur/wipe-out/typewriter-out rendering.
- GraphicsBin (left-panel tab): quick-add title/lower-third/shape,
  templates, brand kits; GraphicsSection in the Inspector: align tools,
  shape editor, animation presets, copy/paste style, brand bindings,
  per-clip + per-version hide.
- `resolve_font` chain: configured → arial → segoeui → omit `fontfile` —
  a missing font degrades instead of failing the render.
- Tests: 8 render e2e pixel tests (shape fill, wipe ltr/out, typewriter,
  blur reveal, shadow, hidden, scale keyframes) + 2 graphics serde tests +
  2 drawtext-opts tests + 11 graphics vitest (ops, version isolation,
  brand apply/unbind, re-sync, roundtrip).

### Fixed — Phase 7
- `drawbox` writes RGB but not alpha — shape coverage is composed into
  the shared `geq` pass (`max(alpha, mask*fillAlpha)`); without it the
  box rendered invisible (found by pixel test).
- drawbox expressions see the box's own `w/h` — anchors now emitted in
  geq-space (`W`/`H`) and translated to `in_w`/`in_h` for drawbox (was
  painting at 0,0 with an opaque-black geq center).
- `applyAnimationPreset` silently dropped `textFx` when a version was
  active — now serialized via `ClipOverride.textFx` (both Rust + TS
  `apply_version` merge it).
- Keyframe expressions on text layers used global `t` as clip-relative —
  scale/opacity/rotate animations now offset by `clip.start_ms` (the
  x/y path already did).

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

## Phase 6 — Audio Studio (ADR-026)
- Waveforms on audio clips: ffmpeg PCM→peaks, disk-cached (xxh3 key),
  job-based, zoom-dependent (~1 bucket/px), canvas-drawn on the clip block.
- Clip audio: pan, fade-in/out (ms), volume keyframes unchanged; track
  gain slider + solo in the header; mute/solo/volume all render-verified.
- Mixing: per-track buses + master alimiter (clipping safety); solo gate
  semantics identical in preview and render.
- Auto-duck: doc-level DuckingRule (src/dst track, threshold, reduction,
  attack/release/hold) → real sidechaincompress; e2e verifies the drop
  during voice and the release after it (apad-extended sidechain bus).
- Loudness: analyze_loudness (EBU R128: I/TP/LRA) + suggest_normalize —
  gain applied to clip.volume non-destructively, limiter suggested when
  needed; UI presets marked orientative, never "required".
- Silence: silencedetect → reviewable region list → applySilenceCut
  (keep-regions with padding, butt-joined, undoable); user reviews first.
- Cleanup fx: highpass/lowpass/3-band EQ/denoise(afftdn)/compressor/
  limiter/deesser/noisegate — canonical Effect model, ffmpeg filters,
  WebAudio mapping where the API allows (rest = render-only, documented).
- Preview: MediaElementSource→fx→StereoPanner→Gain graph with analyser-
  driven ducking; element.volume fallback when AudioContext unavailable.
- Tests: 7 audio e2e (volume/solo mix, pan channels, fades, hp+limiter,
  ducking drop+release, waveform peaks, silence/loudness parse) +
  4 engine vitest (track flags, duck rules, silence-cut splits).
  Totals: 90 rust + 52 vitest green; clippy/fmt/tsc/build clean.
