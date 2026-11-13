# TESTING.md — Creatora

## Test layers

| Layer | Tooling | Scope |
|---|---|---|
| Rust unit | `cargo test` | render-plan generation, project migrations, DB queries, adapters (mocked HTTP) |
| Rust integration | `cargo test` + real ffmpeg | probe/import/export produce valid files (gated on ffmpeg presence) |
| TS unit | Vitest | timeline model ops (split/trim/ripple/undo), keyframe interp, format-override merge logic |
| Component | Vitest + Testing Library | settings, library list states, dialogs |
| Build gate | `tsc --noEmit`, `vite build`, `cargo check`, `cargo clippy`, `cargo fmt --check` | every session before "done" |
| Manual | checklist below | launch, navigation, real editing, export |

## Commands

```bash
# Frontend
npm run test          # vitest
npm run typecheck     # tsc --noEmit
npm run lint
npm run build

# Backend
cd src-tauri
cargo test
cargo clippy -- -D warnings
cargo fmt --check

# Full app
npm run tauri dev
npm run tauri build
```

## Real-media render verification (`src-tauri/tests/render_e2e.rs`)

These tests verify *exported media*, not mocks: they build a `ProjectDoc`, render through ffmpeg, then decode the result and assert on pixels (rgb24 means), PCM RMS, ffprobe duration/stream metadata. Coverage: trim duration, reorder, transform, audio delay, image clips, save/reopen, cancel cleanup, brightness/saturation effects, xfade mid-blend, opacity/volume keyframe ramps, mixed res/FPS, z-order stacking, 16-clip project, 720p canvas, proxy transcode.
render through the same `build_plan` + `run_ffmpeg` path the app uses, then
inspect the output file itself. Skipped only when ffmpeg is absent.

| Test | Asserts via |
|---|---|
| `export_trimmed_clip_has_trimmed_duration` | ffprobe duration of output ≈ trimmed length |
| `reordered_clips_render_in_new_order` | decoded rgb24 frame pixels at t=1s/3s — color dominance flips |
| `transform_scale_and_position_land_on_canvas` | frame pixels: scaled clip occupies exactly the expected half |
| `audio_follows_clip_timeline_position` | decoded PCM RMS: silent before clip start, tone after |
| `image_clip_renders_for_its_duration` | duration + green frame pixels |
| `save_reopen_preserves_timeline_exactly` | store save/open round-trip, JSON-identical timeline |
| `cancelled_render_leaves_no_output` | cancelled flag → Err("cancelled"), no output file |
| `track_volume_and_solo_mix_correctly` | decoded PCM RMS: track gain 0.5 halves RMS; solo isolates |
| `clip_pan_isolates_channels` | per-channel RMS: left-pan clip → right channel ≈ silent |
| `clip_fades_shape_envelope` | RMS ramp-up/down within fade windows |
| `audio_fx_highpass_and_limiter_apply` | HP removes low band vs reference; limiter caps peak |
| `ducking_ducks_music_under_voice` | sidechaincompress: music RMS drops during voice, releases after |
| `waveform_peaks_match_source` | generated peaks ≈ decoded PCM min/max per bucket |
| `loudness_and_silence_parse` | loudnorm JSON fields + silencedetect regions on known signal |
| `shape_rect_renders_filled_box` | drawbox+geq alpha: blue px only inside shape rect, none outside |
| `wipe_reveals_left_to_right` | geq mask: left revealed at mid-wipe, right still hidden |
| `wipe_out_erases_at_tail` | complemented mask at clip tail: visible before, ~gone at end |
| `typewriter_grows_text_over_time` | gated drawtexts: white-px count grows with elapsed time |
| `blur_reveal_sharpens` | gblur+sharp branch crossfade: full-white px lower early than late |
| `shadow_offsets_dark_pixels` | drawtext shadowcolor: dark px offset down-right of red glyphs |
| `hidden_clip_is_not_rendered` | `clip.hidden` filters segment from plan — zero white px |
| `text_scale_keyframes_grow_on_canvas` | `scale eval=frame` on text layer: glyph bbox grows with kf |

Fixtures are generated on the fly by ffmpeg lavfi (`color=` + `sine=`) into
`%TEMP%/creatora_e2e_*` — deterministic pixels and known frequencies, no
binary corpus needed.

## Evidence policy

A task is "tested" only when output is recorded: test run summary, ffprobe dump of exported file, or screenshot/steps for UI. Record results in PROJECT_STATUS.md "Latest test results".

## Manual test checklist (grows per phase)

Phase 1:
- [ ] App launches without console errors
- [ ] Navigation reaches every module placeholder
- [ ] Theme toggle persists across restart
- [ ] Language switch EN↔ES updates all visible strings
- [ ] DB file created; `PRAGMA user_version` = latest migration count
- [ ] Triggered error surfaces as toast with code

## Media test corpus (to assemble in Phase 2/3)

- `short_h264_1080p.mp4` (~10s), `long_h264_4k.mp4` (~10min), `vertical_9x16.mp4`, `no_audio.mp4`, `audio_only.mp3`, `big_image.png` (8K), `hevc.mov` (proxy path), `corrupt.mp4` (error path).
- Corpus lives outside the repo (size); location recorded in `tools/test-media/README.md`.

## Performance budgets (Phase 10 validation)

- Cold start to interactive shell < 3s on mid-range hardware.
- Timeline scrub on 1080p proxy: no dropped frames beyond decode latency.
- Memory: < 1.5GB RSS with a 30-min 4K project open (proxies enabled).
- Export throughput: ≥ 0.5× realtime for 1080p H.264 software encode baseline.

## Phase 8 — Social Studio

| Suite | What it covers | Where |
|---|---|---|
| `social::rules` (lib ×4) | builtin ruleset parses; every platform present; limits typed; versioned override file wins | `src/social/rules.rs` tests |
| `social::validate` (lib ×5) | aspect-ratio error + fix link, empty title, duplicate hashtags, oversized file, clean pass | `src/social/validate.rs` tests |
| `social::posts` (lib ×1) | `extract_hashtags` mirror — punctuation trims only at edges | `src/social/posts.rs` tests |
| `social::oauth` (lib ×2) | PKCE pair S256 shape, state nonce, expiry math | `src/social/oauth.rs` tests |
| `tests/social_db.rs` (×4) | SQLite integration: post+target lifecycle & status rules, cascade delete of targets/attempts, caption templates + hashtag history roundtrip, scheduler `due_targets` | `src-tauri/tests/` |
| `social-types.test.ts` (vitest ×4) | TS `extractHashtags` mirror vs Rust semantics, type guards | `src/lib/` |

Adapter HTTP calls are **not** unit-tested against live APIs (no credentials
in CI); platform flows are exercised end-to-end only with real user apps.
Mocked-HTTP adapter tests are a pending Phase 9 item.

## Phase 9 - Analytics & adapter HTTP tests

- platforms/mock_tests.rs - 17 tests against a raw-TcpListener mock
  server (zero new deps, offline, no credentials): success, invalid
  JSON, HTTP 400/401/403/429(+Retry-After)/500, incomplete body,
  duplicate publication, retry path, timeout, broken connection,
  expired token, failed refresh. Mutex-guarded endpoint overrides;
  poisoned-lock recovery via into_inner.
- tests/analytics_db.rs - 6 SQLite integration tests: snapshot
  roundtrip+dedupe, compare returns only mutually-served metrics,
  insights report insufficient sample, sync-run audit rows, publish
  packet writes folder, CSV import preview+commit.
- src/lib/analytics-types.test.ts - 3 vitest: metricValue returns null
  (not 0) for unserved keys; real 0 stays distinct from missing.

Manual matrix before release (real credentials needed): connect ->
publish test video -> wait -> analytics sync -> verify snapshots match
the platform's own dashboard numbers.
