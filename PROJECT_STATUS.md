# PROJECT_STATUS.md — Creatora

> **This is the authoritative source of truth for development progress.**
> Update at the end of every work session. Verify claims against code, not memory.

## Current state

- **Current phase:** PHASE 8 COMPLETE — Social Studio: posts multi-plataforma, ruleset versionado, validación, captions, calendario local, OAuth+vault, adaptadores reales YouTube/TikTok/Instagram/Facebook con capacidades honestas.
- **Current task:** Phase 9 candidate — local analytics/insights o polish sprint (code-splitting, benchmarks).
- **Build status:** `npm run build` ✓ · `cargo test` 50+4+58+4+2 ✓ (118) · `npm test` 67 ✓ · `tsc` clean · clippy 0 warnings · fmt clean
- **Next exact action:** Phase 9 — pending product decision (analytics local vs perf sprint).

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
| whisper.cpp | bundled (tools/bin, built from source) | Phase 5 |
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

## PHASE 3B/3C/3D — Editor completeness, effects pipeline, performance (COMPLETE — 2026-11-13)

### Delivered

- **Track & batch editing (3A)** — `timeline-engine.ts`: `addTrack`/`removeTrack`/`renameTrack`/`setTrackFlag` (locked/visible/muted)/`moveTrackOrder`; batch ops `moveClips`, `extractClips`/`pasteClips`, `duplicateClips`, `removeClips` — all lock-aware. TimelinePanel: track headers with controls, multi-selection, clipboard, configurable snap, zoom-to-fit, snap/auto-scroll indicators. Store: clipboard + snap config + `previewQuality`.
- **Effects pipeline (3B)** — canonical params shared by `src/lib/effects.ts` (CSS filter/SVG matrix) and `render/effects.rs` (ffmpeg): brightness, exposure, contrast, saturation, temperature, blur — plus transform/opacity. Order-preserved stacks; ADR-016.
- **Keyframes (3B)** — `Clip.keyframes` (clip-relative ms, linear); TS `evalKeyframes` == Rust `eval_at`; ffmpeg `expr`/`expr_var` per-frame expressions on scale/rotate/opacity/x/y/volume; inspector ◆ toggles at playhead; ADR-017.
- **Transitions (3B)** — `Track.transitions`, overlap model; render groups → chained `xfade` (+`afade` audio parity); preview `transitionAlpha` ramp; crossfade/dipToBlack/dipToWhite; ADR-018.
- **Inspector panel** — transform/audio numbers with keyframe toggles, effect stack (add/enable/param sliders/remove), transitions list + crossfade creation.
- **Performance (3C)** — `generate_proxies` job → `proxies/<id>.mp4` (≤960w CRF30 + faststart, `media_assets.proxy_path`, migration 0003); proxy/original quality toggle (default proxy); `preload="auto"` + 3s hidden prefetch window; bounded active-element set; ADR-019.

### Real-media verification — `tests/render_e2e.rs` 16/16, `tests/media_import.rs` 4/4

| Scenario | Assertion |
|---|---|
| Brightness effect | pixels brighten ×1.5 vs baseline render |
| Saturation −1 | red→gray (R≈G≈B <12) |
| Crossfade | pure red → blended mid (R&B>50) → pure blue |
| Opacity keyframe | monotonic ramp on black (0.25t<0.75t) |
| Volume keyframe | PCM RMS ramps ×2 |
| Mixed 160×120@15 + 640×480@60 | normalized to 320×240@30, correct content |
| 2-layer z-order | top 50% blue over full red, center/corner pixels |
| 16-clip project | 16.0s duration + order spot-checks |
| 1280×720 canvas | exact dims + content |
| Proxy generation | 1920→960w playable, duration preserved, DB row |

### Remaining limitations (honest)

- Preview is DOM/CSS compositing (not WebGL): sufficient for the current closed-form effect set (ADR-016); rotation preview still approximates ffmpeg's expanded-`rotw` box.
- Transitions: only linear-ramp kinds (crossfade/dips); no wipes/slides yet.
- Keyframe easing is linear-only (`ease` field reserved); no curve editor UI.
- No frame cache or memory watchdog yet; prefetch window is time-based, not scene-aware.
- `speed` still render-graph-only (no UI); text/graphics tracks still skipped at export.

## Known bugs

None blocking. See Phase-3 limitation list.

## Blockers

- Social platform API credentials do not exist yet (Phase 8 concern).
- `scan_missing_assets`/`relink` verified via unit-level DB ops; full UI click-path needs manual check on next launch.

## Phase 3E — editor hardening (2026-11-13, checkpoint)

Audit → fix loop found and fixed **real bugs**: splitClip keyframe remap, orphan transitions on remove/move, trimClip unbounded by source duration, cross-track moves leaving invalid transition refs, drop-target ignoring the chosen track, empty-clipboard paste (Infinity). Preview/render parity: transition groups now require real overlap; `geq` uses `T` not `t`.

**New in 3E**: text tracks (ADR-020 — canonical TextStyle, drawtext render, DOM preview, pixel-verified); shared keyframe parity vectors both sides (7 cases, 1e-9); `delete_proxy`; partial-proxy cleanup; auto quality degradation (rAF cadence vs frame budget → proxy); decoder set remains bounded by active-clip window + 3s prefetch.

**Stress measured** (not invented): 20 tracks × 100 clips on a 30-min timeline → `build_plan` well under budget, graph emitted; 50-clip render end-to-end in ~2s machine time, duration verified. 4K not yet benchmarked — planned.

## Phase 4 — Multi-Format Studio (2026-11-13, checkpoint)

ADR-021/022/023. `ProjectDoc.versions` (format v2, clean v1 migration): per-version canvas, safe zones, export settings, whitelisted clip overrides (transform / transform.* keyframes / textStyle). Shared timeline — versions can't diverge structurally. `apply_version`/`applyVersion` = single merge semantics for preview + render.

Presets centralized (`format-presets.ts`): 4 aspects + 6 platform presets + safe-zone suggestions; platform = hint, not guarantee. Smart reframe: local motion-centroid via ffmpeg decode → editable keyframes; static → luma centroid → centered. Manual correction always possible — overrides are just keyframes.

UI: VersionsPanel (create/switch/rename/dup/reset/delete, compare side-by-side, auto-reframe per version, batch export → one job per version, independent cancel/fail). Inspector writes to overrides when a version is active (undo-safe). Export honors `versionId`.

**Bug found by tests**: keyframed x/y expressions with commas broke `overlay=x:y` — fixed by quoting expr args (same in drawtext). Real animated pan now pixel-verified.

**e2e**: square cover reframe (blue window), vertical center window (green), keyframed pan (red→blue over time), text in vertical, multi-format export dims, version persistence, real motion tracking on generated moving-subject video.

## Phase 6 done (Audio Studio: waveforms, clip pan/fades, track gain+solo, sidechain ducking, EBU R128 loudness + non-destructive normalize, silence→reviewable cut proposals, cleanup fx, WebAudio preview parity). Prior: Phase 5.

**Audio chain**: per-clip `atrim→atempo→afx→volume(+kf)→track gain→afade→pan→adelay` → per-track buses → `sidechaincompress` ducking (apad-extended) → `amix` → master `alimiter`. Preview mirrors via WebAudio (analyser-driven duck, ±3 dB). Silence/normalize are reviewable proposals — never auto-destructive. Measured (60 s stereo): waveform 63 ms, loudnorm 1.4 s, silencedetect 77 ms.

## Phase 7 done (Text & Graphics Studio + Brand Kit: generated-layer compositor, shapes, real animation presets in preview+render, templates, brand kits with linked elements, per-version graphics independence). Previous: Phase 6 — Audio Studio; Phase 5 done (Subtitle Studio: whisper.cpp transcription, cue editor, ASS/libass burn-in, SRT/VTT/ASS export, per-version styles, karaoke/pop from real word timing). Prior phase: Phase 4.1 — Multi-Format completion (2026-11-13)

**Export settings real**: per-version codec/preset/CRF|bitrate/audio/container validated (reject-not-ignore) and emitted by `ffmpeg_args`; extension corrected to container. e2e: same project → hevc/mkv + h264/mp4 verified via ffprobe codec_name.

**Per-version text**: `ClipOverride.text` + full style override; Inspector text section (content, size, color, align, outline, box) writes to version overrides when active — undo-safe, preview/render identical.

**Reframe audit (ADR-023 addendum)**: EMA smoothing, scene-cut reset, hold-on-exit. Verified: moving subject tracks, static → centered fallback, exit/re-entry holds position (no snap-back). Documented limits: multi-subject → midpoint; no semantics; ONNX extension point recorded.

## Latest test results (2026-11-13, Phase 7)

- `cargo test`: **102 total** — lib 38 (+2 graphics serde, +2 text opts/fallback), media_import 4, render_e2e **58** (+8 graphics: shape fill/outline alpha, wipe ltr/out, typewriter growth, blur reveal, shadow, hidden clip, scale keyframes)
- `npm test`: **63/63** (+11 graphics: generated clips, preset baking base+version, textFx versioning, style copy/paste, align, brand bind/apply/unlink, per-version hidden + re-sync, serde roundtrip)
- `cargo clippy --all-targets`: 0 warnings. `cargo fmt --check` clean. `tsc --noEmit` clean. `vite build` clean.

## Latest test results (2026-11-13, Phase 6)

- `cargo test`: **90 total** — lib 34, media_import 4, render_e2e **50** (+7 audio: mix volume/solo, pan L/R isolation, fades, highpass+limiter, ducking drop-and-release, waveform peaks, silence/loudness parse), subtitles_e2e 2
- `npm test`: **52/52** (+4 audio engine ops: track flags, duck rules, silence-cut)
- `cargo clippy --all-targets`: 0 warnings. `cargo fmt --check` clean. `tsc --noEmit` clean. `vite build` clean.
- Audio perf (60 s stereo WAV, modest CPU): waveform decode 63 ms, loudnorm 1.4 s, silencedetect 77 ms

## Previous results — incl. render plan graph assertions (enable window, atrim range, adelay, mute/visible handling, transform in graph, args/maps).
- `cargo test --test media_import`: **3/3** real ffprobe/ffmpeg import pipeline.
- `cargo test --test render_e2e`: **7/7** — real exported media verified (duration, order via pixels, transform via pixels, audio delay via PCM RMS, image clip, save/reopen fidelity, cancel cleanup).
- `npm test`: **11/11** (3 autosave + 8 timeline-engine). `tsc --noEmit` clean. `vite build` clean (~495 kB).
- Manual: `tauri dev` launches clean; editor module routed; catalog ready.

## Session log

| Date | Session summary |
|---|---|
| 2026-11-13 | Phase 7: Text & Graphics Studio — generated layer compositor (drawbox+drawtext+geq), shapes, anim presets (in/out/emphasis/transition/loop) real in render, templates + brand kits w/ snapshot+slot bindings, per-version graphics overrides, font fallback, preview drag. 102 rust + 63 vitest green. |
| 2026-11-13 | Phase 0: audit + 10 docs committed (f2169b9). |
| 2026-11-13 | Phase 1: app foundation — shell/theme/i18n/settings/SQLite/autosave; verified + committed (4bbef32). |
| 2026-11-13 | Phase 2 partial: `.creatora` format + project CRUD + autosave/recovery + New Project dialog + recents UI; ffmpeg provisioned (9.0.2 GPL); job engine; media import + library UI + missing/relink; integration tests vs real ffmpeg pass. |
| 2026-11-13 | Phase 2 pass 2 (7171df4): favorites, collections/tags, drag-drop import, usage tracking, bundle export + missing-media self-heal. |
| 2026-11-13 | Phase 3 vertical slice: render engine (plan→ffmpeg graph, job-driven export, real progress/cancel), timeline engine + ops, snapshot undo/redo, editor UI (bin/preview/timeline), 7 real-media e2e tests — audited per spec. |

## PHASE 8 — Social Studio & Platform Integrations (COMPLETE, commit TBD)

- **Modelo**: migración `0004_social` — `social_posts` + `social_post_targets` (multi-plataforma, version_id, export_path, caption override, scheduled_at, auto_publish), `caption_templates`, `hashtag_history`, `publication_attempts`. `publications` (0001) queda legacy no usada.
- **Posts**: CRUD, duplicar, estados reales (draft/ready/scheduled/publishing/published/failed — published solo con platform_post_id real), search/filter.
- **Ruleset**: `platform_rules.v1.json` embebido + override por `app_data/platform_rules.vN.json` (versionado, re-verificable); required vs recommended vs account/API-dependent.
- **Validation**: `validate_social_post` — aspect ratio, resolución, duración, tamaño, audio, thumbnail, título, descripción, hashtags duplicados; findings Error/Warning/Recommendation/Passed con fix accionable y deep-link al módulo corrector.
- **Caption Studio**: editor por plataforma (variantes independientes), hashtag manager + historial, plantillas, contadores de caracteres/hashtags por plataforma, preview.
- **Export**: `export_for_target` reutiliza `run_export_body` del pipeline existente, importa el archivo al catálogo y lo linkea al target — sin duplicar lógica de render.
- **Calendario**: scheduler local (tick 60s); `auto_publish=1` + cuenta + archivo → job de publish real; si no, evento `social://due` (recordatorio — nunca afirma publicado). Vistas mes/semana/lista, drag-reschedule, filtros.
- **OAuth**: loopback RFC 8252 + PKCE S256 + nonce state, 3-min window, client_id/secret del usuario (vault keyring — Windows Credential Manager). Refresh dentro del job de publish.
- **Adaptadores reales**: YouTube (resumable upload + thumbnails.set), TikTok (FILE_UPLOAD init+chunks+status — gated por app approval), Facebook Pages (resumable video upload), Instagram (container flow — exige video_url público, error estructurado si no hay hostedUrl).
- **Tests**: +12 lib (rules/validate/scheduler/vault/oauth), +4 integración SQLite (CRUD, cascade, templates/hashtags, due-targets), +4 vitest (extractHashtags mirror + social types).

## PHASE 9 — Analytics, Content Insights & Performance Tracking (COMPLETE)

- **Modelo**: migración `0005_analytics` — `metric_snapshots` (serie temporal por target, `source` ∈ api|import|local, `period`, `metrics_json` normalizado, fetched_at; dedupe por target+period+source+fetched_at), `analytics_sync_runs` (audit de cada sync: trigger, ok/failed, timestamps), `analytics_sync_errors` (error por target con mensaje completo), `import_batches` (file, label, rows seen/imported/skipped, errores), `publish_packets` (target, dir, files[]). Índices por target+fetched_at, remote_id, published_at.
- **Stats adapters** (`social/stats/`): cada plataforma devuelve `{metrics[], unavailable[]}` — métricas canónicas (views/impressions/reach/likes/comments/shares/saves/watch_time/avg_view_duration/followers_gained) con nombre, unidad, source; las no soportadas llevan razón explícita. YouTube (videos.list statistics + Analytics API reports para watch_time), TikTok (video/query fields — requiere video.list), Instagram (media insights por media_type — professional only), Facebook (video insights endpoint).
- **HTTP layer** (`platforms/http.rs`): `HttpError{status, body, retry_after}` tipado + `ep(key, default)` overrides test-only — toda URL de adaptador pasa por ep().
- **Sync engine**: `analytics_sync` manual/auto (intervalo configurable en settings, enganchado al scheduler de 60s), cooldown por target (freshness window), refresh en 401, Retry-After en 429, persistencia de run+errores, nunca afirma éxito si la API falló. `analytics_sync_status` + `analytics_sync_runs` para el panel.
- **Dashboard**: resumen (posts/alcance/engagement por fuente, nunca suma métricas incompatibles — cada métrica se agrega solo dentro de su plataforma), series temporales por plataforma, top/bottom posts, filtros 7/30/90/365d + plataforma.
- **Detail**: métricas del último snapshot + unavailable con razón, histórico de snapshots, historial de consultas (sync runs del target), errores, sync manual, series temporales SVG.
- **Compare**: 2–20 posts, solo métricas servidas por ambas (noData explícito), warning mixed-platform, sort por métrica.
- **Insights**: locales y offline — top posts, mejor plataforma, mejor duración, mejor horario, hashtags con más engagement; cada insight lleva muestra n, fuente de evidencia y caveat (correlación ≠ causalidad, muestra pequeña declarada).
- **Publish packets**: carpeta por target (video hardlink→copy, thumbnail, metadata.txt legible + publication.json), batch, regenerable, registrado en `publish_packets`.
- **Import CSV/JSON**: ≤10 MiB, preview (format detect, columnas, rows matched/unmatched por remote_id, issues), commit sin sobreescritura (dedupe), source='import' + label de usuario, audit batch.
- **Tests**: +17 mock HTTP adaptadores (success/400/401/403/429+RetryAfter/500/malformed JSON/body incompleto/duplicado/retry/timeout/expired token/refresh fail/conexión cortada), +6 integración engine (snapshot roundtrip+dedupe, compare solo-métricas-comunes, insights sample-size, sync audit, packet, csv import), +3 vitest (metricValue null-vs-0).
