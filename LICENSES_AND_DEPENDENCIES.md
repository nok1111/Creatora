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
