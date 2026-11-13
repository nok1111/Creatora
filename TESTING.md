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

These tests verify *exported media*, not mocks: they build a `ProjectDoc`,
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
