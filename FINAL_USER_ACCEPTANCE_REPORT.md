# FINAL USER ACCEPTANCE REPORT — Creatora Editor

Date: 2025-11-14
Build under test: `src-tauri/target/debug/creatora.exe` (Tauri 2 + WebView2, dev server :1420, CDP :9222)
Reference commits: `690e3ea` (AnchoredMenu autofocus), `445d937` (multi-clip drag fix — new this session)
Project used: `Untitled project 5.creatora` (Master 9:16 1080×1920 + Square 1:1, 5 clips, 2 subtitle cues)

---

## 1. Executive summary

The acceptance session exercised the running editor with **OS-level physical input**
(Windows `SendInput` via `qa/osinput.py`, plus pyautogui and WinRT InputInjector attempts),
**CDP real-input automation**, and **real file/job verification** (FFmpeg, whisper-cli, ffprobe).

Headline results:

- **1 functional defect found and fixed**: multi-clip drag moved only the dragged clip → `445d937`.
- **1 hard environment limitation**: native HTML5 drag (MediaBin → Timeline) cannot be completed
  by any injected-input technology available to an unattended agent — WebView2's OLE `DoDragDrop`
  loop cancels synthetic sessions immediately after `dragstart`. This is a *test-harness* limit,
  not an app defect; the same drop path was verified with a real DataTransfer payload in Etapa C.1.
- **Timeline navigation, panel resize, menus, preview/playback, subtitles, Whisper and the final
  export all passed with physical and/or real-pipeline verification.**
- Final export: real `.mp4` — H.264 1080×1920 @30 fps + AAC 48 kHz, 10.2 s, decodes cleanly,
  subtitles burned into the pixels.

**Readiness call (factual, not approval):** all acceptance-gate items pass *except* "physical
drag & drop of new media", which is **NOT TESTED** for reasons outside the app's control.
Per the acceptance conditions, that item needs a real human mouse before RC sign-off.

---

## 2. Method legend

| Tag | Meaning |
|---|---|
| PHYS-MOUSE | OS-level mouse via `SendInput` / `move_abs`+`click_abs`+`drag_abs` (`qa/osinput.py`) |
| PHYS-KEY | OS-level keyboard via `SendInput` (VK codes + KEYEVENTF_UNICODE) |
| CDP | Chrome DevTools Protocol real input (`Input.dispatchMouseEvent/dispatchKeyEvent`) + DOM inspection |
| IPC | Direct Tauri command invocation (setup or pipeline verification only, never faked UI events) |
| FILE | Real file/job verification: ffprobe, exported files, `.creatora` contents |

---

## 3. Test matrix

### ETAPA 1 — Drag & Drop físico

| # | Test | Method | Result |
|---|------|--------|--------|
| 1.1 | Video MediaBin → timeline | PHYS-MOUSE (SendInput + pyautogui + InputInjector) | **PENDING HUMAN** — see §6 D2, checklist §9 |
| 1.2 | Audio → audio track | idem | **PENDING HUMAN** — same limitation |
| 1.3 | Image → timeline | idem | **PENDING HUMAN** — same limitation |
| 1.4 | Move clip within track | PHYS-MOUSE | **PASS** — clip moved +150 px |
| 1.5 | Clip → compatible track | PHYS-MOUSE | **PASS** — big_image lane 1 → lane 0 |
| 1.6 | Drop on locked track | PHYS-MOUSE (existing clip) | **PASS** — rejected, clip stayed in A1 |
| 1.7 | Incompatible drop | CDP (new-media drag unavailable) | **PASS (CDP)** — audio→video track rejected |
| 1.8 | Multi-selected clip drag | PHYS-MOUSE | **PASS after fix** — defect D1, `445d937` |
| 1.9 | Drag near start/end | PHYS-MOUSE | **PASS** — x0=176 = t=0 |
| 1.10 | Drag with snapping | PHYS-MOUSE | **PASS** — exact snap x0=1280 |
| — | Insertion ghost / track highlight / cursor / final pos / selection / undo-redo | PHYS-MOUSE + CDP | **PASS** — ghost = final position; undo restored both clips |

### ETAPA 2 — Timeline navigation

| Test | Method | Result |
|---|---|---|
| Wheel = horizontal | PHYS-MOUSE | **PASS** — scrollLeft 0→100→400→0 |
| Shift+Wheel = vertical | PHYS-MOUSE | **PASS** — scrollTop 0→46 |
| Ctrl+Wheel = temporal zoom | PHYS-MOUSE | **PASS** — scrollWidth 170 464→136 446→109 232 |
| Zoom anchored to cursor | CDP (measured) | **PASS** — 4 585 ms preserved pre/post zoom |
| UI zoom buttons | CDP | **PASS** |
| Navigation over clips / ruler | PHYS-MOUSE | **PASS** |
| Multi-track scroll | PHYS-MOUSE | **PASS** — 4 lanes |
| Scrubbing | PHYS-MOUSE | **PASS** — tc 06:09→09:13, playhead x=901 |
| Rapid zoom changes | PHYS-MOUSE | **PASS** — consistent factor, no lag |
| Wheel isolation from other panels | PHYS-MOUSE | **PASS** — no cross-panel scroll |

### ETAPA 3 — Panel resize & persistence

| Test | Method | Result |
|---|---|---|
| Resize Media/Graphics panel | PHYS-MOUSE | **PASS** — handle 171→271 |
| Min clamp | PHYS-MOUSE | **PASS** — clamped back to 171 |
| Resize Inspector | PHYS-MOUSE | **PASS** — 1581→1501 |
| Timeline height | PHYS-MOUSE | **PASS** — divider moved both directions |
| Min/max/double-click reset | CDP (C.1) + PHYS | **PASS** |
| Resize window w/ adjusted panels | OS window resize (1384×761) | **PASS** — handles repositioned, no overlap |
| Persistence after reload+reopen | PHYS + reload | **PASS** — 171/1501/780 restored exactly |
| Smaller-resolution safety | 1280×720, 1366×768 | **PASS** — no inaccessible panels |

### ETAPA 4 — Menus & controls

| Test | Method | Result |
|---|---|---|
| New Format: open, autofocus, ↓/Home/Enter/Esc/outside | PHYS-MOUSE + PHYS-KEY | **PASS** |
| Clip context menu (right-click, items, Escape, edge pos) | PHYS-MOUSE | **PASS** — menu inside viewport |
| GraphicsBin flyout on hover | PHYS-MOUSE | **PASS** — anchored right of row |
| Export dialog open / Escape close | PHYS-MOUSE + PHYS-KEY | **PASS** |
| Menu after scroll | CDP (C.1) | **PASS** — flyout tracks anchor |
| Keyboard nav (regression of 690e3ea) | PHYS-KEY | **PASS** — autofocus + roving works |

### ETAPA 5 — Preview & playback

| Test | Method | Result |
|---|---|---|
| Play/Pause (transport button) | PHYS-MOUSE | **PASS** — video.currentTime 0→0.81 |
| Space toggle | PHYS-KEY | **PASS** |
| Seek via ruler click | PHYS-MOUSE | **PASS** — tc 04:11 / 07:21, playhead at click x |
| Preview↔Timeline sync | PHYS-MOUSE | **PASS** — tc 07:21→08:22 in 1.0 s, playhead 1100→1224 |
| 16:9 / 9:16 / 1:1 transport centering | CDP measure (C.1) | **PASS** — dx=0 each |
| Compare mode | CDP (C.1) | **PASS** — two panes, independent transport |
| Window resize | OS resize | **PASS** — no drift/overlap |

### ETAPA 6 — Beginner flows

| Flow | Method | Result |
|---|---|---|
| A: open → project → import → place → play → trim → title → vertical → export | PHYS + CDP + FILE | **PASS** end-to-end |
| B: audio → audio track → volume 1→0.5 → preset → play | PHYS-MOUSE + PHYS-KEY | **PASS** |
| C: multi clips → tracks → move → snap → split → undo/redo | PHYS-MOUSE + CDP | **PASS** |

UX observations (opportunities, **not** defects — unchanged per rules):
1. First drop requires manually creating a track ("+ Video"/"+ Audio") — not obvious to beginners.
2. Multi-select (Ctrl+click) and trim handles are undiscoverable until hover/trial.
3. Whisper model names ("tiny/base/small + MB") are technical.
4. Unsaved-changes guard works and is clear (encountered live; "Continue without saving" flow verified).

### ETAPA 7 — Languages & resolutions

| Check | Method | Result |
|---|---|---|
| English UI @1280×720 | OS resize + FILE | **PASS** — no overflow; clipped buttons all inside scroll areas |
| Spanish UI @1366×768 | OS resize + PHYS | **PASS** — full translation of editor chrome |
| 1920×1080 | OS resize | **PASS** |
| Resize during session | PHYS | **PASS** — menus re-place correctly |
| Untranslated strings | DOM scan + locale diff | **FIXED `4da7fbe`** — `nav.exports`→"Exportaciones", `qualityProxy/Full`→"Vista previa: …", `snapshots`→"Capturas:", `autoSync`→"Autosincronización:", plus hardcoded Inspector/GraphicsInspector property labels moved to `editor.prop*` keys. Verified live in both languages (shots `29_i18n_es_inspector`, `30_i18n_en_inspector`) |

### ETAPA 8 — Whisper & final export

| Test | Method | Result |
|---|---|---|
| Model availability | IPC + FILE | **PASS** — `whisper-cli.exe` bundled; `ggml-tiny`/`ggml-base` installed |
| Real transcription | PHYS-MOUSE + whisper-cli job | **PASS** — 8.5 s real speech (SAPI-generated) → 2 cues |
| Cue editing | PHYS-KEY | **PASS** — typed "Real subtitle test" |
| Persistence | FILE | **PASS** — cues inside saved `.creatora` |
| SRT export | IPC (pipeline) | **PASS** — valid SRT, correct timings |
| VTT export | IPC (pipeline) | **PASS** — valid WEBVTT |
| SRT via native save dialog | PHYS-KEY on OS dialog | **INCONCLUSIVE** — see §6 D3 |
| Burn-in in video export | FILE (frame extract) | **PASS** — caption pixels visible in output |
| Final export (video+audio+title+subs+9:16) | PHYS-MOUSE + native dialog + FILE | **PASS** — H.264 1080×1920@30 + AAC 48 kHz, 10.2 s, 3.36 MB, decodes clean |

---

## 4. Evidence

Screenshots: `qa/shots/19_ctx_menu_physical.png`, `20_export_dialog.png`,
`21_gfx_flyout_physical.png`, `22_1280x720_en.png`, `23_1366x768_es.png`,
`24_1920x1080_es.png`, `25_subtitles_panel.png`, `26_transcribing.png`,
`27_transcribed_cues.png`, `28_export_dialog_final.png`.
Exported artifacts: `qa/qa_out.srt`, `qa/qa_out.vtt`, `qa/final_export.mp4`,
`qa/frame_2s.png` (burn-in visible), `qa/frame_6s.png`.

## 5. Defects found

### D1 — Multi-clip drag moved only the dragged clip — **FIXED `445d937`**
- **Severity**: Medium-High (required acceptance item).
- **Repro**: select two clips (Ctrl+click), physically drag one → only it moved.
- **Cause**: `TimelinePanel.tsx` computed `moveClips(next, others, target - cur.startMs)`;
  after snapping, `target - cur.startMs` ≈ 0 every frame, so companions never moved.
- **Fix**: track the previous snapped position and move all selected clips by the
  incremental per-frame delta.
- **Verified**: both clips +80 px; Undo restored both; Redo re-applied both.

### D2 — Native HTML5 drag cannot be driven by injected input — **ENVIRONMENT, NOT TESTED**
- SendInput, pyautogui and WinRT InputInjector all produce `dragstart` (payload verified
  correct: `application/x-creatora-asset` + path), but WebView2's OLE `DoDragDrop` loop
  cancels the session immediately — `dragover`/`drop` never reach the timeline.
- This is a known WebView2/automation boundary, not application behavior.
- Mitigation evidence: same drop path verified in C.1 via real DataTransfer injection;
  all *pointer-based* drags (move/trim/cross-track/locked/snapping/multi-clip) passed physically.
- **Action needed for RC sign-off: one human drag of video/audio/image from MediaBin.**

### D3 — SRT export through the native save dialog — **INCONCLUSIVE under automation**
- Twice: native "Guardar como" opened, filename typed into the filename Edit control,
  Enter pressed, dialog closed — but no `.srt` appeared in any checked location.
- The identical technique **did** succeed for the video export (`final_export.mp4`
  saved via the same native-dialog typing path), so the app side is healthy.
- `export_subtitles` invoked directly produced valid SRT+VTT — pipeline verified.
- Likely automation nuance (dialog folder state / focus), not an app defect; flagged for honesty.

### Findings (no fix applied — product decisions)
- ~~`nav.exports`, `Preview: proxy` and related strings left in English~~ → **resolved in `4da7fbe`**.
- Final export reported "1 clip(s) skipped (missing media)" — the QA project's graphics clip
  references media generated in a previous unsaved session; honest feedback, expected.

## 6. Corrections applied & commits

| Commit | Change |
|---|---|
| `445d937` | `fix(editor): move the full clip selection together on drag` — TimelinePanel incremental-delta fix |
| `4da7fbe` | `fix(i18n): translate remaining visible strings in Spanish editor` — Exports→Exportaciones, Vista previa, Inspector property labels, hide tooltips |

Regression after fix: TypeScript clean, Vitest 10 files / 100 tests, multi-clip drag re-tested live.

## 7. Test-environment limitations

- **No physical human available**: "physical" input = Windows `SendInput`/WinRT injection.
  Indistinguishable from real input for pointer-based interactions, but HTML5 OLE drag is
  the documented exception (D2).
- **Native OS dialogs** (save-file pickers) are outside the WebView; they were driven via
  SendInput where possible (video export succeeded; SRT inconclusive D3).
- Dev build (`npm run tauri dev`), not a signed release installer.
- Whisper test used `ggml-tiny` — transcription accuracy is inherently approximate;
  pipeline correctness, not transcription quality, was the test target.

## 8. Remaining Release-Candidate risks

1. **MediaBin→Timeline HTML5 drag** — only unverified acceptance item; needs one human pass
   (checklist in §9).
2. SRT save-dialog path (D3) — low risk; pipeline proven, but a human click-through is cheap insurance.
3. ~~Minor i18n gaps in Spanish~~ — resolved in `4da7fbe` (verified both languages).
4. Long-session stability (autosave, memory) not stress-tested in this window.

## 9. Human-verification checklist — MediaBin → Timeline drag

Status: **PENDING HUMAN CONFIRMATION** — not PASS. Automated OS-level injection cannot complete
WebView2's OLE `DoDragDrop` loop (see D2). Please run this once with a real mouse:

Setup: open any project, open the MEDIA tab, have at least one video, one audio file and one
image in "Project media". Create a video track and an audio track (+ Video / + Audio at the
left of the timeline if none exist).

- [ ] Drag a **video** from MediaBin onto a video lane → insertion ghost follows the cursor,
      lane highlights, clip lands where the ghost was, clip is selected after drop.
- [ ] Drag an **audio** file onto an audio lane → same behavior on the audio track.
- [ ] Drag an **image** onto a video lane → clip appears (image clips are allowed on video tracks).
- [ ] Drag over a **locked** track → no-drop cursor / rejection, nothing changes on release.
- [ ] Drag an **audio** file over a **video** lane → rejected (incompatible type).
- [ ] Drop near the start (t=0) and at the end of the timeline → clip lands at the ghost position.
- [ ] With snapping on (magnet icon), drop near another clip's edge → clip snaps exactly to the edge.
- [ ] Undo (Ctrl+Z) removes the dropped clip; Redo (Ctrl+Y) restores it.

If all boxes check out, items 1.1–1.3 and 1.7 (physical) can be marked PASS.

---

## 10. RC1 final gate

### 10.1 RC1 artifact

| Field | Value |
|---|---|
| Version | `1.0.0` |
| Installer | `src-tauri/target/release/bundle/nsis/Creatora_1.0.0_x64-setup.exe` |
| Size | 62,045,784 bytes (~59.2 MiB) |
| SHA-256 | `e37f4c28456ff89a21a42528109775fd7cf5075779d1c21d70286405efb29e41` |
| Signature | **NotSigned** — SmartScreen will warn "unknown publisher" on first run. A public release needs a real code-signing certificate (OV/EV); intentionally postponed, not simulated. |
| Reference commit | `ee3d9d5` (docs); artifact built from `96fd0f3` + `e817492` lockfile sync |

Full details: `RELEASE_CANDIDATE_REPORT.md`.

### 10.2 Verified during RC1 (installed build, not `tauri dev`)

- Silent install `/S`, first launch, fresh SQLite migrations (0001,0002,0004–0007), project create/save/close/reopen, media import, export (H.264 1080×1920@30 + AAC 48 kHz, decode clean, caption burned — `qa/shots/rc1_14_export_frame.png`), uninstall, reinstall.
- AppData preserved across uninstall→reinstall; existing projects reopen; `app.language` setting persists; installed Whisper models (`ggml-tiny`, `ggml-base`) remain available.
- Interrupted-job recovery: planted `running` job swept to `interrupted` on next launch.
- UX sweep EN+ES across all modules — no fake metrics, no dead buttons, empty states correct.
- Rust: check/clippy clean, 148/148 tests. Frontend: tsc clean, Vitest 100/100.

Defects fixed during RC1: `0e724a8` (spurious "missing media" under text clips), `96fd0f3` (Spanish Home leftovers), `0d32d8a` (tsconfig baseUrl deprecation — build-config only).

### 10.3 GUI installation test — VERIFIED (OS input, real wizard)

Evidence: `qa/shots/gui_01`–`gui_15`. Performed on this machine, real user profile, real AppData:

| Check | Result |
|---|---|
| GUI wizard | PASS — Welcome → install location → extract → complete → finish pages |
| Install path | `%LOCALAPPDATA%\Programs\Creatora` (per-user, no admin required); 218.4 MB required |
| Desktop shortcut | Created at finish (default checked), removed on uninstall |
| Start Menu entry | `…\Start Menu\Programs\Creatora.lnk` created and removed |
| Registry entry | `HKCU\…\Uninstall\Creatora` (DisplayName, v1.0.0, InstallLocation) registered and removed |
| First launch | PASS — "Run Creatora" checkbox launched app, Home rendered |
| Relaunch after close | PASS — via desktop shortcut |
| Running-app handling | Uninstaller detects running instance and offers to kill it |
| Windows uninstall | PASS — `uninstall.exe` GUI completes; binary, shortcuts, registry removed |
| "Delete application data" option | Present, **unchecked by default** — AppData fully preserved (DB, models, thumbs, autosaves) |

### 10.4 Still pending — requires human confirmation

1. **MediaBin → Timeline HTML5 drag** — checklist §9 above (video, audio, image, ghost/highlight, final position, timeline edges, locked track, incompatible drop, snapping, undo/redo). **NOT PASS until confirmed.**
2. Nothing else outstanding for RC1; code signing is a product decision, not a defect.

### 10.5 Known limitations

- No second Windows profile could be created (no admin); virgin-state tests used a reversible AppData rename — real user data restored intact afterward.
- WebView2 requires the Evergreen runtime; offline machines get the bootstrapper flow.
- GUI install test was driven by OS-level input, not a human clicking — visually verified via screenshots.

**Creatora is NOT declared ready for distribution.** Awaiting human confirmation of §9 and product sign-off on the unsigned installer.

**Stopping here — awaiting user confirmation of pending items.**
