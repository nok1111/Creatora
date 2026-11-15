# Creatora — Release Candidate 1 Report

**Status: RC1 prepared — NOT declared ready for distribution. Awaiting final user approval.**

## 1. Reference commit

`e817492` (HEAD of `main` at report time). Installer artifacts were built from working tree at `96fd0f3`; `e817492` only syncs `Cargo.lock` metadata with the 1.0.0 version bump — identical build inputs.

Relevant RC commits:

| Commit | Change |
|--------|--------|
| `96fd0f3` | i18n: translate Home leftovers in Spanish |
| `0e724a8` | Preview: skip media-less clips in missing-media check |
| `d19b365` | RC1 documentation and third-party notices |
| `0e2b8cb` | Version bump 0.1.0 → 1.0.0 |
| `a9fa41d` | Align index.html meta CSP with production config |
| `bc50019` | Propagate app_data_dir failure instead of writing to cwd |
| `4da7fbe` | i18n: remaining visible strings in Spanish editor |
| `445d937` | Move the full clip selection together on drag |
| `690e3ea` | AnchoredMenu keyboard navigation |

## 2. Version

`1.0.0` — consistent in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, and installed file metadata (`ProductName=Creatora`, `FileVersion=1.0.0`, `ProductVersion=1.0.0`).

## 3. Installer SHA-256

NSIS (`src-tauri/target/release/bundle/nsis/Creatora_1.0.0_x64-setup.exe`):

```
e37f4c28456ff89a21a42528109775fd7cf5075779d1c21d70286405efb29e41
```

An MSI is also produced: `bundle/msi/Creatora_1.0.0_x64_en-US.msi`.

## 4. Size

- NSIS installer: **62,045,784 bytes** (~59.2 MiB)
- Installed payload: **229,083,035 bytes**

## 5. Installed resource inventory (verified on disk, not config)

| File | Size (bytes) | Purpose |
|------|-------------|---------|
| `creatora.exe` | 16,173,568 | Application binary (v1.0.0) |
| `tools/bin/ffmpeg.exe` | 105,423,872 | FFmpeg 9.0.2 essentials build — render |
| `tools/bin/ffprobe.exe` | 105,221,120 | Media probing / thumbnails / waveforms |
| `tools/bin/whisper-cli.exe` | 2,104,320 | Local subtitle transcription |
| `tools/THIRD_PARTY_NOTICES/CREATORA_DEPENDENCIES.txt` | 2,933 | Dependency inventory |
| `tools/THIRD_PARTY_NOTICES/LICENSE` | 35,147 | FFmpeg/GPL notice bundle |
| `tools/THIRD_PARTY_NOTICES/README.txt` | 41,557 | Notices index |
| `tools/THIRD_PARTY_NOTICES/WHISPER_CPP_LICENSE.txt` | 1,099 | whisper.cpp MIT license |
| `uninstall.exe` | 79,399 | NSIS uninstaller |

**Verified absent:** dev source, `node_modules`, test media, Rust build dirs, Whisper model files (`ggml-*.bin` are user-downloaded to AppData only), `.env` files, debug symbols.

**WebView2:** app uses the system WebView2 Runtime (Evergreen) — the NSIS bundle includes the Tauri WebView2 bootstrapper logic; offline machines without the runtime get the Microsoft bootstrapper flow. Documented in INSTALLATION_GUIDE.

**Stale artifact:** `Creatora_0.1.0_x64-setup.exe` (62,041,145 B) remains in the nsis folder from the pre-release build — kept intentionally; it is not part of RC1.

## 6–7. Tests and results

### Build & static checks — all PASS

| Check | Result |
|-------|--------|
| `tsc --noEmit` | PASS (clean) |
| `vitest run` | PASS 100/100 |
| `cargo check` | PASS |
| `cargo clippy` | PASS (no warnings beyond linker messages) |
| `cargo test` | PASS 148/148 (unit + e2e render/subtitle/social/db) |
| `npm run build` (vite prod) | PASS |
| `npm run tauri build` | PASS — NSIS + MSI produced |

### Installation lifecycle (virgin AppData) — PASS

Tested on `nokturno` with `%APPDATA%\com.creatora.app` temporarily renamed (reversible; real data preserved, restored at end):

| Step | Result |
|------|--------|
| Silent install `/S /D=<path>` | PASS — installs to custom path, ProductVersion 1.0.0 |
| Normal (GUI) install | PARTIAL — GUI was launched once during QA but the completed path used `/S`; GUI flow not re-run end-to-end |
| First launch | PASS — Home renders, clean first-run state |
| SQLite migrations | PASS — fresh `creatora.db`, migrations 0001,0002,0004–0007 applied |
| Create project | PASS |
| Media import (video/audio/image) | PASS — assets `ok`, thumbnails generated |
| Save / close / reopen | PASS — `Untitled project 8.creatora` reopens with all clips/cues/versions |
| Export | PASS — H.264 1080×1920@30 + AAC 48 kHz, 6 s, decode clean |
| Uninstall `/S` | PASS — binary removed |
| AppData preserved on uninstall | PASS — DB, autosaves, thumbs, waveforms, jobs retained |
| Reinstall | PASS — recents and export history reappear from preserved DB |
| Existing project after reinstall | PASS — opens with clips, versions, cue |
| Interrupted-job recovery | PASS — planted `running` job swept to `interrupted` on next launch |
| Settings persistence | PASS — `app.language` retained across uninstall→reinstall |
| Installed Whisper models after reinstall | PASS — `ggml-tiny`/`ggml-base` listed as Installed with real AppData |

### Installed-app integral flow — PASS

On the installed build only (no `tauri dev`): create → import video+audio+image → add Title graphic → add subtitle cue → add 16:9 version → set clip opacity → save → close → reopen → export.

Output verified with bundled ffprobe/ffmpeg: `1080x1920 h264 30fps + aac 48kHz mono, 6.000 s, 849,048 B`, decode clean; extracted frame shows image clip + Title + burned "New cue" caption. Evidence: `qa/shots/rc1_14_export_frame.png`, `C:\Temp\creatora-qa\rc1_export.mp4`.

### UX sweep (installed, EN+ES) — PASS with 2 fixed defects

Home, Media Library, Create, Editor, Export Center, Social Studio, Analytics, Settings reviewed in English and Spanish: real data only, no fake metrics, empty states render correctly, no clipped elements or dead buttons observed. Evidence: `qa/shots/rc1_ux_*.png`.

### Pending human confirmation — NOT TESTED (as required)

- **HTML5 drag MediaBin → Timeline** (video, audio, image), ghost/highlight, drop position, locked track, incompatible drop, snapping, undo/redo. Checklist: `FINAL_USER_ACCEPTANCE_REPORT.md` §9. WebView2's OLE `DoDragDrop` rejects all synthetic input technologies (SendInput, pyautogui, WinRT InputInjector) — requires a human mouse session.

## 8. Evidence index

- Screenshots: `qa/shots/rc1_*.png` (launch, editor, export dialog, export frame, module sweep EN+ES, post-reinstall, whisper models)
- Export artifact: `C:\Temp\creatora-qa\rc1_export.mp4`
- Saved project: `C:\Users\nokturno\Documents\Creatora\Projects\Untitled project 8.creatora`
- Prior evidence: `screenshots/`, `FINAL_USER_ACCEPTANCE_REPORT.md`, `RELEASE_CANDIDATE_AUDIT.md`

## 9. Defects found during RC1 work

| # | Defect | Severity | Status |
|---|--------|----------|--------|
| 1 | "missing media" placeholder rendered under text/graphics clips (media-less clips have no `mediaRef`) | Medium (visual) | FIXED `0e724a8`, verified in installed app |
| 2 | Spanish Home leftovers: `library.importMedia` wrong key, missing `home.viewAll`, raw English job status badge | Low (i18n) | FIXED `96fd0f3`, verified in installed app |
| 3 | `models_dir` fell back to cwd on app_data_dir failure | Medium | FIXED `bc50019` |
| 4 | index.html CSP allowed `https:` img-src while prod config did not | Low | FIXED `a9fa41d` |
| 5 | Pre-release version metadata (0.1.0) | Release blocker | FIXED `0e2b8cb` + `e817492` |

## 10. Corrections and commits

Each defect has an independent commit (table §1 and §9). No uncommitted functional changes remain except QA artifacts (`qa/`, `screenshots/`, reports).

## 11. Remaining risks

- **Unsigned binaries** — installer and `creatora.exe` are `NotSigned`. SmartScreen will show "unknown publisher" on first run; acceptable for a private RC, requires a real code-signing certificate (EV or OV + reputation) for public distribution. Documented, not simulated.
- **Physical drag test pending** — the only functional gap; app code path verified via DataTransfer, but user must confirm with a real mouse.
- **Bundle identifier `com.creatora.app`** — retained for AppData continuity; would need migration if changed for future macOS.
- **No single-instance enforcement** — two app instances can run; documented as known issue.
- **Unregistered `0003_proxy_path.sql` migration** — flagged in audit; not modified (no schema change without demonstrated need). Existing DBs already carry `proxy_path`; fresh DBs reach it via later migrations — verified on virgin install.

## 12. Environment limitations

- Single Windows profile (`nokturno`); no admin rights to create a second account — virgin state approximated by reversible rename of `com.creatora.app` (restored afterward; QA copy kept as `com.creatora.app.qavirgin`).
- `LOCALAPPDATA` cannot be redirected for WebView2 (fails with `0x8007139F`); virgin test used normal known folders.
- Native file pickers driven via real OS input; CDP evals blocked during modal dialogs (expected).
- GUI (non-silent) install exercised only partially.

## Verdict

Installer builds, installs, runs, persists data correctly across uninstall/reinstall, recovers interrupted jobs, exports verified video. **Not declared ready for distribution** — pending: human drag confirmation (§9 checklist) and product decision on code signing.
