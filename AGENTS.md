# Creatora

Tauri desktop video editor — React 19 + TypeScript + Vite (frontend), Rust (backend),
FFmpeg bundled for export. Projects persist as `.creatora` documents
(`doc.timeline.tracks[].clips[]`, `effects[]` per clip).

## Commands

```bash
npm run dev          # Vite dev server → http://localhost:1420
npm run tauri dev    # full app (CDP debug on :9222 for QA)
npx tsc --noEmit     # typecheck — must stay clean
npx vitest run src/lib/fx src/modules   # FX/unit tests
cargo test --lib    # Rust tests (from src-tauri/)
```

Runtime QA lives in `qa/` — `qa/cdp.py` talks to the app over Chrome DevTools
Protocol (port 9222). The page exposes `window.__qa` =
`{useProject, useEditor, engine, api, jobs}` — `useProject.getState()` gives
`{doc, filePath, setDoc, openFromPath}`.

## FX / creative-filter architecture (current, validated)

**One manifest, two engines.** `shared/fx/build.ts` generates
`shared/fx/manifest.json` — every effect/filter entry declares `kind`
(`"filter" | "effect" | "transition" | "generator"`), params with defaults,
a `lut` op list and spatial params (`vig, grain, ca, bloom, hal, sharp, soft`).

- LUT ops: `temp, tint, sat, vib, lgg, curve, split, mixer, hsl, fade, levels`.
  `mixer` = 3×3 channel matrix (luminance-aware monochrome). TS interpreter:
  `src/lib/fx/lut.ts`; Rust interpreter: `src-tauri/src/render/fxlut.rs`.
  Parity pinned by `shared/fx/lut-golden.json` + `fxlib_parity.rs` — **regenerate
  the golden JSON whenever a recipe changes** (`npx tsx qa/fx-render.ts` helpers).
- Spatial ops run as FFmpeg fragments in export (`src-tauri/src/render/fxeffects.rs`,
  `filter_fragments`) and as shader uniforms in preview (`gl-filter.ts` FRAG).
  Intensity scales spatial uniforms and mixes the LUT (ops commute with
  trilinear sampling → no rebake on slider drags). `intensity=0` → no pass at all.
- Filter ops must exist on BOTH interpreters — check before adding new op keys.

**Preview (WebGL2, shared compositors):**
- `src/lib/fx/gl-filter.ts` — `FilterGL` singleton: source canvas → RGBA texture,
  33³ 3D-LUT (trilinear) + spatial uniforms, ping-pong FBOs for filter stacks.
  ANGLE caveat: `UNPACK_FLIP_Y_WEBGL` must be false before `texImage3D`.
- `src/lib/fx/gl-transition.ts` — `TransitionGL` singleton for library
  transitions (program per entry+ease, `release()` on idle → `dispose()`).
- `src/modules/editor/FilterLayer.tsx` / `TransitionLayer.tsx` — per-clip
  transparent 2D canvas layered in DOM order over the (still mounted, hidden)
  media element. Media stays for decode/audio/sync — never remove it.

**Preview.tsx invariants (learned the hard way — don't regress):**
- Media element refs MUST be stable per clip (`refFor` → `refCbs` map).
  An inline `ref={el => ...}` detaches+reattaches every commit → `layerEls`
  goes null mid-commit → FilterLayer draws blank ~50% of frames in playback.
- Media sync (volume/rate/drift/play) runs in `useLayoutEffect` every render,
  NOT inside the ref callback.
- Drift correction: never re-seek while `el.seeking`, and ≥1200ms cooldown
  after a correction during playback — otherwise seek treadmill pins
  `readyState` at 1 and every raster layer blanks.
- `rasterizeLayer` accepts `readyState >= 1` (a seeking video still presents
  its last frame). Requiring ≥2 blanks layers through every correction.
- GL health is PER-compositor: `glFilterOk` / `glTrOk`. A layer only drops its
  own path after ~60 consecutive failed renders; filter failure →
  `filterGL().release()` + retry after 2s. Never reintroduce a single shared
  sticky latch — that was the "filters vanish during playback" bug.
- On context loss both compositors recover via `contextrestored` →
  `onStatus('ok')` → React re-enables the layer.

**Effect model:** `clip.effects[]` = `{id, type, enabled, params, inMs?, outMs?}`.
`type` = manifest entry id. Max **3 active filters per clip** (enforced in
`TimelinePanel` ~line 677). `filterPassesFor(clip, relMs)` resolves
enabled+in-window filter effects → passes (order = stack order).

**Thumbnails** (`shared/fx/thumbs/*.png`, 384px) are generated through the REAL
FFmpeg chain — not the GL preview — so bin tiles match export. Bin wiring:
`EffectsBin.tsx` `import.meta.glob` (must be `../../../shared`, not `../../`).

## The 10 creative presets (user-reviewed, DO NOT retune without approval)

`goldenFilm, tealOrange, dreamy, disposable, cyberNeon, darkMood, luxury,
softGlow, bleachBypass, monochrome` — each approved after visual comparison
sheets in `qa/out/`. Their identities: filmic analog / modern cinematic /
diffusion pastel / 90s flash / neon triad / noir / editorial / optical glow /
silver-retention / fine-art B&W.

## Verification expectations

Any FX change: `tsc` clean → vitest → `cargo test --lib` → regenerate
`lut-golden.json` if recipes changed → eyeball a comparison sheet from the
real FFmpeg chain (`qa/fx-render.ts`), same source/exposure across panels.
Ignored Rust tests cover the E2E chain (`filter_verify`, `filter_thumbs`,
`contact_sheet`, `perf_1080p`) — run with `cargo test -- --ignored`.

## QA project

`C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora`
— multi-clip test timeline used for live preview checks.

## Social Studio (`src/modules/social/`, `src-tauri/src/social/`)

- **Saving a post**: always `api.saveSocialPost(id, input, markReady)` →
  `save_social_post` (one transaction: upsert targets, prune removed platforms
  except `published`/`publishing`, optional draft→ready). `next_target_status`
  in `posts.rs` is the only place that decides a target's status on edit —
  published/publishing are never rewritten by edits or calendar drags.
- **Scheduler reminders** fire once per (target, scheduled_at) (in-memory set).
- **Card previews** come from `social_post_previews` (own thumbnail → export →
  linked project's first clip). Projects never store a thumbnail themselves.
- **Validator findings** carry `code` + `params`; UI text lives in `find.<code>`
  / `find.<code>_fix` (en/es), Rust `message` is only the English fallback.
  New finding ⇒ add the code to both locales and emit `.with(json!({...}))`.
- **Mark ready** is blocked only by composer-fixable content errors
  (`title_empty`, `title_too_long`, `caption_too_long`); media errors exist
  only after export.
- **Retry** in History is offered only for a target's newest failed/cancelled
  attempt, behind a confirm dialog (real upload).
- `PlatformIcon` (lucide + TikTok glyph) is the single source of brand icons.
- Live QA: `qa/qa_social_s1s3s4.py`, `qa_social_s2.py`, `qa_social_s5.py`,
  `qa_social_s6.py` (need the app on CDP :9222; they clean up what they create;
  s6 seeds attempt rows in `%APPDATA%/com.creatora.app/creatora.db`).
- Launching the dev binary for QA: Vite on :1420, then
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 src-tauri/target/debug/creatora.exe`
  (Rust changes need the exe closed first — Windows locks it).
