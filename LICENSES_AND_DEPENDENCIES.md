# LICENSES_AND_DEPENDENCIES.md — Creatora

> Legal/licensing audit. Creatora is a **closed-source commercial** product — every redistributed component must be checked for obligations.

## FFmpeg — the critical decision

FFmpeg is invoked **exclusively as an external subprocess** (`ffmpeg.exe`, `ffprobe.exe`) spawned by the Rust core (ADR-003). Creatora never links `libav*` and never contains FFmpeg code.

### Which build to ship

| Option | License | Codecs | Verdict |
|---|---|---|---|
| GPL build (`--enable-gpl`, incl. libx264/x265) | GPL-2/3 | Full (best H.264/265 quality) | Usable: subprocess keeps our code separate. Obligation: ship GPL notice + **written source-code offer / link** for the exact build. Most third-party builds (gyan.dev "full", BtbN) are GPL. |
| LGPL build (`--enable-version3`, no GPL libs) | LGPL-3 | Reduced (no x264; OpenH264 + hardware encoders) | Fewer obligations but weaker encoder quality; OpenH264 H.264 quality is notably worse than x264. |

**Chosen approach:** ship a **GPL ffmpeg build as separate executables** (`ffmpeg.exe`/`ffprobe.exe` in `tools/`), because:
- Arm's-length subprocess invocation is the widely accepted boundary (separate program, command-line interface — the same position taken by many commercial tools bundling ffmpeg).
- Best encoder quality (x264/x265) for a commercial export engine.
- Obligations are mechanical and satisfiable: include GPL license text, exact build version + configure flags, and a written offer + URL for corresponding source in About/notices and installer.

**Residual risk:** the "separate program" boundary for *distributed* GPL executables is the mainstream interpretation but is a legal judgment, not a guarantee — flag for counsel review before commercial release. Fallback ready: swap to LGPL build + OpenH264/NVENC without code changes (probe detects available encoders).

**Record at build time:** ffmpeg version string, configure flags, source URL/commit, license texts in `tools/THIRD_PARTY_NOTICES/`. Startup probe runs `ffmpeg -version` + `ffmpeg -hide_banner -encoders` to verify capabilities and detect missing codecs → settings shows encoder availability.

### Provisioned build (dev, 2026-11-13)

- **Version:** ffmpeg 9.0.2-essentials_build (gyan.dev release-essentials)
- **License:** GPL v3 (per bundled README; `--enable-gpl` in configure)
- **Source:** https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- **Downloaded:** https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
- **Notices:** `tools/THIRD_PARTY_NOTICES/LICENSE` (GPL-3), `README.txt` (build readme)
- **Location:** `tools/bin/ffmpeg.exe` + `ffprobe.exe` (gitignored — provisioned, not committed)
- **Key encoders confirmed:** libx264, libx264rgb, h264_amf, h264_nvenc (+ h264_qsv, hevc_nvenc/qsv/amf, libx265, aac, libmp3lame)
- **HW accel:** d3d11va, d3d12va, dxva2, nvdec/nvenc, amf, cuda — runtime availability depends on user GPU; exporter must probe and fall back.
- **Location in build:** `media::tool_path()` resolves exe-dir → repo `tools/bin` (debug) → `CREATORA_FFMPEG`/`CREATORA_FFPROBE` env → PATH.

### Codec patent note
H.264/H.265/AAC decoding+encoding in distributed software may implicate patent pools (MPEG LA/Access Advance/HEVC Advance). FFmpeg's license covers copyright, not patents. Patent-licensing exposure is a **commercial decision to flag** — many distributors ship anyway; note it, don't resolve it here.

## Planned dependency licenses

### Rust (src-tauri)
| Crate | Purpose | License | OK? |
|---|---|---|---|
| tauri 2 | app framework | MIT/Apache-2.0 | ✓ |
| rusqlite (bundled) | SQLite | MIT | ✓ (SQLite itself: public domain) |
| tokio | async runtime | MIT | ✓ |
| serde / serde_json | serialization | MIT/Apache-2.0 | ✓ |
| keyring | Credential Manager | MIT/Apache-2.0 | ✓ |
| reqwest | HTTP for OAuth/API | MIT/Apache-2.0 | ✓ |
| uuid, time/chrono, anyhow, thiserror | utils | MIT/Apache-2.0 | ✓ |
| xxhash-rust | asset hashing | BSL-1.0 | ✓ (permissive) |
| tracing + tracing-subscriber | logging | MIT | ✓ |
| image, fast_image_resize | thumbnails | MIT/Apache | ✓ |
| oauth2 (or manual flow) | OAuth | MIT/Apache-2.0 | ✓ |

### Frontend
| Package | Purpose | License | OK? |
|---|---|---|---|
| react, react-dom | UI | MIT | ✓ |
| typescript, vite | toolchain | Apache-2.0/MIT | ✓ |
| tailwindcss | styling | MIT | ✓ |
| shadcn/ui (radix-ui primitives) | components | MIT | ✓ |
| zustand | state | MIT | ✓ |
| @tanstack/react-query | server-state | MIT | ✓ |
| i18next, react-i18next | i18n | MIT | ✓ |
| lucide-react | icons | ISC | ✓ |
| fabric.js or konva (graphics module, Phase 6) | canvas editor | MIT | ✓ (verify at add time) |
| vitest, @testing-library/* | tests | MIT | ✓ |

### Sidecar tools
| Tool | Purpose | License | Obligations |
|---|---|---|---|
| ffmpeg / ffprobe | media engine | GPL-3 build | License text + source offer + notices (above) |
| whisper.cpp | transcription (Phase 5) | MIT | Notice |
| whisper.cpp models (ggml) | speech models | MIT (ggml format of OpenAI Whisper weights — MIT) | Notice + model provenance |

## Rules going forward

- No new dependency without license recorded here + `cargo`/`npm` audit for advisories.
- No GPL/AGPL **linked** dependencies. GPL **tools** only as isolated subprocesses.
- Copyleft-compatible? No. Avoid SSPL (MongoDB), CC-BY-NC, Commons Clause — anything non-commercial.
- Fonts/media shipped in-app must be commercially redistributable (OFL fonts OK; record each).
- Third-party notices shipped in-app (About → Licenses) and in installer.

## Phase 5 additions
- **whisper.cpp** — MIT. Built from source (CPU/AVX2); `whisper-cli.exe`
  provisioned to `tools/bin/` (gitignored like ffmpeg).
- **ggml whisper models** (tiny/base/small, from huggingface.co/ggerganov/
  whisper.cpp) — MIT per upstream model cards; ~75MB/142MB/466MB. Downloaded
  ONLY on explicit user action (`download_model`); never bundled.
- **ureq 3.x** — MIT/Apache-2.0. Blocking HTTP for model download (replaces
  heavier reqwest; rustls TLS).
- **libass** — bundled inside the provisioned ffmpeg build (already licensed
  there); used via `subtitles` filter for burn-in.

Model size/hardware guidance: tiny ≈75MB RAM-light ~realtime on modern CPU;
small ≈466MB slower-but-accurate. No GPU build shipped yet (whisper.cpp CUDA
is a future optional build); CPU AVX2 is the baseline.

## Audio processing (Phase 6)

- **ffmpeg audio filters** — afftdn/acompressor/alimiter/deesser/agate/
  equalizer/sidechaincompress/loudnorm/silencedetect ship inside the
  provisioned ffmpeg binary (same license as the existing build; invoked
  as a subprocess, no linking changes).
- **WebAudio API** — browser/webview built-in; no new dependency.
- **xxhash-rust** — BSL-1.0 (already listed; waveform cache keys).

## Phase 10 audit additions

- **Removed**: `@tauri-apps/plugin-fs` (npm) - unused, no capability.
- **Verified present + licensed** (actual Cargo.toml): parking_lot
  (MIT/Apache-2.0), keyring 3.6 (MIT/Apache-2.0), sha2 (MIT/Apache-2.0),
  base64 (MIT/Apache-2.0), webbrowser (MIT/Apache-2.0), ureq 3 (MIT/
  Apache-2.0) - the table's "reqwest" row is superseded by ureq (already
  listed Phase 5); tauri-plugin-dialog/log (MIT/Apache-2.0).
- **npm audit**: 0 vulnerabilities (2026-11). **cargo-audit**: not run
  (tool absent) - Phase 11 CI item.
- **Icons**: lucide-react ISC - covered by table. **Fonts**: none bundled.
- No new dependencies added this phase.
