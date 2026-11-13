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

## ADR-013 — Timeline time model: integer milliseconds + frame snapping

**Decision:** All persisted times (`Clip.startMs`, `durationMs`, `sourceInMs`, markers, cues) are **integer milliseconds** — never float seconds, never frame numbers. Frame alignment is an *editing* concern applied at the operation layer: `msToFrame(t) = round(t·fpsNum/(fpsDen·1000))` and `frameToMs(f) = round(f·fpsDen·1000/fpsNum)`; move/trim/split snap through these. Export converts `ms/1000` to exact seconds for ffmpeg; preview derives source time as `sourceInMs + (t − startMs)·speed`.
**Why:** Integer ms is exact (no float drift on long timelines), trivially serializable, and coarse enough for ms-level audio sync while frame snapping gives sample-accurate UX at any project fps. Frame numbers would break under variable-fps sources; float seconds accumulate error.
**Consequence:** A clip edge can sit between frames internally; the *renderer* quantizes by construction because ffmpeg selects frames by PTS — verified by e2e duration/order tests.

## ADR-014 — Undo/redo: document snapshot stack, not inverse ops

**Decision:** `useEditor` keeps `past[]`/`future[]` stacks of `ProjectDoc` snapshots. Every mutation funnels through `mutate(fn)` which pushes the pre-edit doc onto `past` and clears `future`. Continuous gestures (drag/trim) coalesce: the snapshot is taken on gesture *start*, intermediate frames mutate without pushing. Stack capped at 100 entries (~few MB; docs are JSON).
**Why:** Inverse-operation undo is elegant but every new clip/effect/property op needs a correct inverse — the classic source of "undo corrupts the project" bugs. Snapshots are total: undo restores *everything*, including future fields we haven't invented yet. Memory is bounded and documents are small.
**Rejected:** Command-pattern inverse ops (error-prone, incomplete coverage); CRDT (no multiplayer need); event-sourcing (debug complexity for zero gain here).

## ADR-015 — Render graph: absolute-placement overlay/mix, not per-track concat

**Decision:** The Rust render plan turns each clip into an independent segment: `trim/setpts` video fed into `overlay` at `(x,y)` gated by `enable='between(t,start,end)'` over a `color` base; audio via `atrim/asetpts/volume/adelay(startMs)` into `amix`. No `concat` filter.
**Why:** Absolute placement treats sequential, overlapping, reordered and gapped arrangements *identically* — the graph structure doesn't change when clips move, which makes the model identical to the preview's compositor (one layer per active clip at time T). Concat would force per-track contiguous packing and a separate enable-mapping pass.
**Consequence:** Graph size grows linearly with clip count (fine; ffmpeg graphs handle thousands of nodes). A/V sync is guaranteed by construction: video gate and audio delay consume the *same* `startMs`.

## ADR-016 — Effects: canonical param registry mirrored in CSS/SVG and ffmpeg

**Decision:** Effects live on `Clip.effects` as ordered `{type, enabled, params}` entries. Two registries consume the *same* canonical params: `src/lib/effects.ts` (preview → CSS `filter:` / SVG `feColorMatrix`) and `src-tauri/src/render/effects.rs` (export → ffmpeg filter fragments chosen to be *exactly* expressible in both worlds, e.g. saturation uses the W3C matrix via `colorchannelmixer`, not `hue=s=`).
**Why:** "Preview looks like export" is a commercial requirement. Restricting v1 to effects with exact closed-form equivalence (multiply/gain, affine curves, linear matrices, gaussian blur) makes parity provable with pixel tests rather than aspiration.
**Consequence:** New effects enter only when a matched pair exists; unknown kinds are ignored both sides (forward-compat). DOM/CSS compositor suffices for this set — WebGL deferred to when GPU-only effects (e.g. LUTs, warp) land.

## ADR-017 — Keyframes: piecewise-linear, clip-relative ms, dual evaluator

**Decision:** `Clip.keyframes: path → [{tMs,v,ease}]`, clip-relative ms, linear interpolation, clamped at both ends. Identical evaluator exists in TS (`evalKeyframes`) and Rust (`eval_at` + `expr`/`expr_var` generating nested `if(lt(t,…))` ffmpeg expressions). Animatable paths are an explicit allow-list (`transform.*`, `volume`).
**Why:** One interpolation definition shared by preview and render eliminates the classic "looks different after export" class of bugs; expressions evaluate per-frame inside ffmpeg so ramps are sample-accurate. Linear-only v1 keeps the math provably identical; `ease` field is reserved for future curves.
**Consequence:** geq uses `T` not `t` — `expr_var` parameterizes the variable name. UI keyframes are set at the playhead via the inspector ◆ toggles.

## ADR-018 — Transitions consume overlap (ripple model), xfade/afade render

**Decision:** `Track.transitions` records `{type,durationMs,clipA,clipB}`; creating one shifts clip B so `B.start = A.end − duration` (the standard non-linear editor overlap model). Render groups linked clips per track into maximal runs → `xfade` chains (canvas-padded inputs) for video and symmetric `afade` in/out for audio; preview applies the equivalent alpha ramp (`transitionAlpha`) over the overlap.
**Why:** Overlap-based transitions keep clips as independent timeline objects — moving or trimming either side just re-derives the overlap. Ripple-insert semantics (B does not move) were rejected: they make "extend a transition" ambiguous.
**Consequence:** `dipToBlack`/`dipToWhite` render as alpha-half-fades (fadeblack/fadewhite xfade); unknown kinds cut. E2E verifies the midpoint blend has both sources' pixels.

## ADR-019 — Preview proxies: display-only mezzanine, never a render input

**Decision:** `generate_proxies` (job engine) transcodes video assets to `proxies/<id>.mp4` (H.264 ≤960w CRF30 + AAC96k, faststart) recorded in `media_assets.proxy_path`. The preview swaps to the proxy when `previewQuality == "proxy"` (default); **export always reads originals** — `media_refs` paths are untouched.
**Why:** Preview smoothness must never trade against export fidelity. Because a proxy is a pure decode substitution (same duration, same timeline), the single source-time model is unaffected — no dual-path sync logic.
**Consequence:** Along with `preload="auto"` on active elements and a 3s look-ahead prefetch window of hidden decoders, multi-clip playback stays smooth; memory stays bounded because only active+prefetch elements exist at any time.

## ADR-020 — Text tracks: canonical TextStyle on the clip, drawtext ↔ DOM span

**Status**: accepted · **Phase**: 3E

**Context**: Text needs a single canonical model shared by preview and render (per the "no shallow titles" requirement). Fontconfig is not configured on the dev host, so font resolution must be an explicit file path, not a family name.

**Decision**: `Clip.text` + `Clip.text_style` (TextStyle: fontFile?, fontSizePx, color, outlineColor/Width, backgroundColor/Pad, alignH/V). Render: transparent `color` source inside filter_complex → `drawtext` (explicit `fontfile`, escaping at the option level) → same gated-overlay path as media layers, so z-order, timing, transform offset and opacity/keyframes reuse existing machinery. Preview: flexbox container (alignH↔justify, alignV↔items) + span with `cqh`-scaled font-size/stroke/box + translate(evalT.x/y). v1 scope = exactly the subset both sides express identically; richer text (shadows, per-word styles, curves) extends the same model later.

**Alternatives**: rasterized text images (breaks keyframing/preview parity), ASS subtitles (wrong layer — that's for export subtitles, not design text), SVG→ffmpeg drawsvg (extra moving parts, no preview benefit).

**Consequences**: fontFile defaults to `C:\Windows\Fonts\arial.ttf` on Windows — a `fontFile`-less doc on another OS falls back to nothing usable; Fontconfig default font substitution for missing fontfile is a known follow-up. drawtext x/y accept `t` (verified); geq requires `T` (verified).

## ADR-021 — Format versions: shared timeline + whitelisted per-clip overrides

**Status**: accepted · **Phase**: 4A

**Context**: One project, many aspect-ratio outputs. The alternative — a full copy of the timeline per version — duplicates every structural edit and invites divergence bugs; a separate engine per version violates the single-model rule.

**Decision**: `ProjectDoc.versions: Vec<FormatVersion>` (format_version 2; v1 `formats` map migrates cleanly — it was never populated). A version holds its own `canvas`, `safeZones`, `export` settings and `clipOverrides` keyed by clip id. The whitelist is strict: `transform`, `keyframes` on `transform.*` paths, `textStyle`. Timing, effects, audio, track structure are shared — versions can NEVER diverge structurally. `apply_version` (Rust) / `applyVersion` (TS) produce the merged doc that preview and render both consume — the same merge function semantics, one engine.

**Alternatives**: timeline-per-version (rejected: edit divergence), per-clip "aspect variants" inline on clips (rejected: bloats every clip, harder to reset).

**Consequences**: Inspector routes transform/keyframe writes to overrides when a version is active (undo covers it — all mutations are doc-level). Structural edits while a version is active apply to the shared timeline — intended.

## ADR-022 — Format presets: centralized catalog, dimensions ≠ guarantees

**Status**: accepted · **Phase**: 4B

**Decision**: `src/lib/format-presets.ts` is the single source of truth: preset id, label, canvas dims, safe-zone suggestions, platform hint, suggested duration cap. Platform fields are *recommendation metadata* — the UI never claims publish-compatibility. Rust never sees preset ids; versions persist concrete canvas numbers.

## ADR-023 — Smart reframe: local motion-centroid tracking, no ML required

**Status**: accepted · **Phase**: 4C

**Decision**: `render/reframe.rs` decodes a clip's window to 96px grayscale via ffmpeg and computes the centroid of frame-to-frame change (motion energy), falling back to a luminance centroid for static scenes. Samples → `transform.x/y` keyframes written as version overrides — always user-editable. Handles subjects exiting/re-entering: motion-less frames fall back, keyed positions interpolate.

**Alternatives**: ONNX face detection (documented future option — model ~5-20 MB, license varies, hardware-dependent); static-center framing only (rejected — not detection).

**Consequences**: Honest scope — tracks movement/salience, not semantics. License-clean, offline, deterministic; verified against synthetic moving-subject video.

## ADR-024 — Export settings: validated, wired, never silently ignored

**Status**: accepted · **Phase**: 4.1

**Context**: Versions stored export settings but the encoder used hardcoded defaults — a silent-ignore failure mode.

**Decision**: `ExportSettings` extended (codec/preset/crf | videoBitrate, audioCodec/bitrate/rate, container). `validate_export` enforces a hard matrix — unknown codec/preset/container or incompatible combos (vp9→mp4, h264→webm) are REJECTED, not adjusted. `build_plan_with` carries validated settings into `RenderPlan`; `ffmpeg_args` emits exactly those; `export_project` corrects the file extension to match the container. UI shows the effective settings line before export.

**Consequences**: Two versions of one project provably export different encoders/containers (e2e-verified via ffprobe codec_name). Unsupported but valid ffmpeg codecs remain unavailable until added to the matrix — an explicit product decision, not a bug.

## ADR-023 addendum — Reframe stabilization (Phase 4.1)

Motion centroid output now passes a stabilization pass: EMA smoothing (α=0.35) against jitter, scene-cut reset on change-spikes (no glide across cuts), and hold-last-position on unreliable frames (subjects exiting/re-entering don't snap back to center). Remaining known limits: tracks *the* moving mass — two simultaneous subjects produce a midpoint, not a choice; fast cuts may yield a few re-anchor frames; no semantic understanding (a waving flag in background competes with a static speaker). Semantic detection (ONNX face/person models, ~5–25 MB, MIT/Apache licensed typically, CPU-usable) stays a documented extension point — the current centroid is the baseline mode.

## ADR-025 — Subtitle pipeline: whisper.cpp → cues → ASS/libass burn-in

**Context.** Phase 5 needs local transcription, word-level highlighting,
external exports and burn-in — reusing the canonical model, not a second engine.

**Decision.**
- `doc.subtitles: Vec<SubtitleCue>` (existing field, now real) — cues are
  timeline-absolute ms, shared across versions. `SubtitleStyle` wraps the
  canonical `TextStyle` (glyphs) + `highlightColor`, `mode`
  (none|karaoke|pop), `marginVPx/Hpx`. `FormatVersion.subtitle_style: Option`
  overrides presentation per version; cue CONTENT stays shared (documented
  scope — a `cues` override field is the extension point if needed).
- Transcription: bundled `tools/bin/whisper-cli.exe` (whisper.cpp, MIT,
  CPU/AVX2). `-ojf` JSON gives real token offsets → `WordTiming` merged at
  space boundaries. No invented/uniform word times — when whisper emits no
  tokens, karaoke simply degrades to plain cues.
- Burn-in: cues → ASS → libass `subtitles` filter appended at the END of
  the video chain (`RenderPlan::with_ass`). ASS handles wrapping, outline,
  box, margins and `\k` karaoke — drawtext can't do karaoke cleanly.
  Preview mirrors the same model in DOM (margins, align, word color).
- Exports: SRT/VTT/ASS writers in `subtitles/mod.rs`; per-version via
  `apply_version` before serializing; each export is an independent job.
- Model download: `download_model` (ureq → `.part` → rename) only on
  explicit user action; `list_models` reports presence/tier/size so the UI
  can state when a download is required. Models under `tools/models/` or
  app-data; never bundled silently.

**Alternatives rejected.** drawtext for burn-in (no karaoke/wrapping);
whisper server/API (violates local-first + adds token cost); distributing
models in-repo (size + licensing clarity).

## ADR-026 — Audio Studio: canonical chain, real ffmpeg filters, sidechain ducking

**Context.** Phase 6 turns the single `clip.volume` scalar into a mixer:
waveforms, clip/track gain, pan, fades, cleanup fx, ducking, loudness and
silence tools — without a second audio engine.

**Decision.**
- One canonical audio chain per clip in `render/plan.rs`:
  `atrim → atempo → audiofx → volume(+kf) → track gain → afade(in/out)
   → pan → adelay` feeding per-track buses; doc-level `DuckingRule`s map
  to ffmpeg `sidechaincompress` (source bus `asplit` → `apad` so the
  sidechain survives the source ending), and a master `alimiter` closes
  the mix (clipping safety, always on).
- New model fields, all `#[serde(default)]` back-compatible:
  `Clip{pan, fadeInMs, fadeOutMs}`, `Track{volume, solo}`,
  `doc.ducking: Vec<DuckingRule>`. Solo semantics: any solo ⇒ only soloed
  tracks audible (both preview and render).
- Audio fx reuse the SAME `Effect` registry (`type`/`params`/`enabled`)
  as video fx — `render/audiofx.rs` maps highpass/lowpass/eq/denoise
  (afftdn)/compressor(acompressor)/limiter/deesser/noisegate(agate) to
  ffmpeg filters; `effects.ts` gains `AUDIO_EFFECTS` with matching params.
- Preview parity via WebAudio: `audio-preview.ts` builds
  MediaElementSource → fx (Biquad/DynamicsCompressor for the mappable
  kinds; denoise/limiter/noisegate/deesser are render-only, documented)
  → StereoPanner → Gain. Ducking reads an AnalyserNode on the SOURCE
  element per rAF and drives the target's gain with attack/release/hold —
  same detection model as sidechaincompress, ±3 dB tolerance.
- Waveforms: `audio::waveform` decodes to mono s16 → per-bucket min/max
  peaks, cached on disk keyed by xxh3(path+mtime+buckets); job-based,
  ~1 bucket per rendered px (zoom re-requests). Silence/loudness are
  analysis commands — `silencedetect`/`loudnorm` parsed — that produce
  REVIEWABLE proposals (`applySilenceCut` splits into keep-regions with
  speech padding; `suggestNormalize` returns a gain the UI applies to
  `clip.volume`, undoable, adding a limiter fx when headroom requires).
  Nothing mutates without user action.

**Alternatives rejected.** WebAudio render pipeline as canonical (not
frame-exact, can't encode); uniform-split silence auto-cut (destructive
without review); per-clip loudnorm two-pass render (expensive — gain
suggestion achieves the same loudness non-destructively); separate audio
effect registry (duplicate schema for no gain).

**Measured.** 60 s stereo WAV: waveform decode 63 ms, loudnorm 1.4 s,
silencedetect 77 ms — all far faster than realtime on a modest CPU.

## ADR-027 — Graphics Studio: generated layer per clip, geq-composited alpha, snapshotted brand kits

**Context.** Phase 7 needs titles/shapes/animations/brand identity that
render identically in the DOM preview and in ffmpeg exports, without a
second compositor and without preview-only effects.

**Decision.**
- **One transparent layer per generated clip.** Every text/graphics clip
  emits `color=c=black@0.0:size=WxH` → `drawbox` (shape) → `drawtext`(s)
  → `scale eval=frame` (keyframed scale, canvas-center pivot) → `rotate`
  → `geq` alpha pass → `overlay` gated by `enable=between(t,start,end)`.
  The preview mirrors this with a canvas-sized wrapper carrying
  scale/rotation so pivots match exactly. ADR-020 established the
  drawtext↔DOM parity rule; this extends it to transforms and alpha.
- **`drawbox` does not write alpha** (verified empirically): a filled
  box on a transparent layer stays invisible. Shape coverage is composed
  into the same `geq` pass as a `max(alpha, between-mask * fillAlpha)`
  term — one filter expresses shape + opacity + wipe masks together.
- **Anchor constants differ per filter.** `drawtext` anchors use
  `w/h/text_w/text_h`; `drawbox` expressions see the *box's own* `w/h`
  (input dims are `in_w`/`in_h`); `geq` sees plane `W/H`. The planner
  emits anchors in geq-space and translates for drawbox — getting this
  wrong silently paints the box at (0,0) with an opaque-black center.
- **Animation presets bake canonical keyframes** (10 eased samples per
  ramp; render's piecewise-linear eval ≈ the curve). What keyframes can't
  express is `Clip.textFx` — procedural kinds implemented on BOTH sides:
  `typewriter` (N drawtexts gated per char window ↔ prefix slice),
  `wipe` (geq mask `lt(X,W*p)` etc. ↔ CSS clip-path inset), `blur`
  (layer fork: `gblur` branch + sharp branch, alpha crossfade ↔ CSS
  blur+opacity dual div). `textFx.out=true` anchors the window at the
  clip tail with the mask complemented — real exit anims, not reversed
  playback.
- **Per-version animation.** `ClipOverride.textFx` (and `hidden`)
  serialize into the version's override map; `apply_version` merges them
  exactly like transform/textStyle — one version's wipe never leaks into
  another. `clearVersionClipOverrides` is the explicit re-sync op.
- **Brand kit = app-side store + project snapshot.** Kits live in
  `app_data/brandkits/*.json`; selecting one embeds a *copy* into the
  doc so the project stays self-contained. `Clip.brandBindings` are slot
  indices, applied on bind and re-applied ONLY by the explicit "apply
  brand" action — custom edits on unbound slots are never touched, and
  unlinking keeps the current values.
- **Templates = canonical `Clip` JSON** in `app_data/templates/*.json`
  (optional `brandKitId`). Self-contained, importable/exportable as
  files, applicable to any project — the clip IS the template, no
  secondary schema.
- **Font handling.** `resolve_font` picks configured → arial → segoeui;
  a missing configured font falls back instead of failing the render.
  `fontfile` is omitted entirely if no candidate exists.

**Alternatives rejected.** SVG/HTML overlay pipeline (breaks parity and
pulls a browser dependency into render); ellipse/circle shapes (drawbox
can't do them — unsupported rather than faked); auto-rewriting bound
clips on kit edit (silent overwrite of user styling); preview-only
CSS animations (violates the ADR-020 rule).

**Verified.** Pixel tests: `shape_rect_renders_filled_box` (drawbox+geq
alpha), `wipe_reveals_left_to_right`, `wipe_out_erases_at_tail`,
`typewriter_grows_text_over_time`, `blur_reveal_sharpens`,
`shadow_offsets_dark_pixels`, `text_scale_keyframes_grow_on_canvas`,
`hidden_clip_is_not_rendered`.

## ADR-028 — Social Studio: local-first posts + honest adapters (Phase 8)

**Decision.** Social content is modelled as `social_posts` +
`social_post_targets` (per-platform rows: version, export file, caption
override, schedule, auto_publish). Publishing is dispatched per-platform
through `social/platforms/*` adapters; `published` is ONLY written when
the adapter returns a real `platform_post_id` — an export is never a
publish.

**Platform rules** live in a versioned JSON ruleset
(`platform_rules.v1.json` embedded; `app_data/platform_rules.vN.json`
wins). Each rule carries `level` (required/recommended/account/api)
because limits change and depend on account type — UI never hardcodes
numbers.

**Credentials.** Tokens + OAuth client secrets go to Windows Credential
Manager via `keyring` (DPAPI). SQLite stores metadata only. OAuth is
authorization-code + PKCE + loopback listener (RFC 8252); the user
supplies their own developer-app client_id — nothing embeds secrets.

**Honest capability gating.** Instagram's Graph API requires a public
`video_url` — pure-local publish is impossible, so the adapter returns a
structured limitation error unless the user hosts the file. TikTok runs
the real Content Posting flow but gated scopes surface the API error
verbatim. Facebook Pages and YouTube run real resumable uploads.

**Scheduler.** Local tick; auto-publish only when auto_publish+account+
file all exist, else emits `social://due` reminder — scheduled ≠ will-
publish.

**Migration note.** `0003_proxy_path.sql` is intentionally NOT
registered — `proxy_path` already ships inside 0001's CREATE TABLE, so
running it would break every existing DB (duplicate column).

## ADR-030 - Source-aware metric snapshots (Phase 9)

**Decision.** Analytics are stored as append-only `metric_snapshots`
rows carrying `source` in {api, import, local}, `period`, and a
normalized `metrics_json` - never as mutable per-post counters.
Comparison only exposes metrics served by every selected target;
missing values render as "-", not 0.

**Why.** Platform metrics disagree in semantics (a TikTok "view" is not
a YouTube "view"). Summing them would fabricate data. Snapshot rows
preserve history for charts and make provenance queryable; dedupe on
(target, period, source, bucket) prevents import pollution.

**Alternatives rejected.** A single stats column on targets (loses
history), per-platform metric tables (duplicated schema), normalizing
to "engagement" scores (false equivalence - banned by requirements).

**Endpoint overrides.** All adapter URLs go through `ep(key, default)`
backed by a `Mutex<Vec>` test hook - enables the offline mock-HTTP
suite without dependency-injection plumbing or new crates.

**MSRV.** EP_OVERRIDES uses `Mutex<Vec>` (const-stable in 1.77) instead
of `LazyLock` (1.80) to keep the declared `rust-version` honest.

## ADR-031 - Phase 10 hardening decisions

**CSP.** Strict policy added; `style-src 'unsafe-inline'` is a deliberate,
documented exception - timeline/preview position elements via dynamic
`style={}` and refactoring to CSS custom-property classes buys nothing
security-wise (same-surface attribute). `script-src 'self'` is the real
XIX kill and is absolute.

**Asset scope `**` kept.** convertFileSrc must serve media from any user
location; scoping to app dirs breaks the product. Mitigations: CSP +
React-only rendering (zero dangerouslySetInnerHTML). Residual risk filed.

**Lazy modules, not lazy components.** React.lazy per top-level module
(one Suspense in App.tsx): predictable chunks, no layout-shift inside
pages. Shell + Home stay eager for instant first paint.

**Playhead isolation.** playheadMs fires at rAF rate; only tiny overlay
components subscribe. Heavy panels read getState() in handlers - the
subscription-boundary pattern now documented in ARCHITECTURE.md.

**64 MiB project cap.** Real .creatora files are KB-low MB (JSON timeline
docs). The cap sits far above legitimate sizes while bounding parse
memory on malformed files.

**plugin-fs removed.** Zero imports, no capability grant, no rust plugin -
dead dependency cut rather than carried.
