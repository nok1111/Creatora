# PHASE 10 AUDIT — Creatora hardening

Baseline (pre-fix, measured on this machine):
- JS bundle: **684.21 kB** single chunk (201.05 kB gzip) — all 6 modules eager.
- CSS: 29.82 kB (6.68 kB gzip).
- Tests: 141 rust + 70 vitest green; clippy 0 warnings.
- `npm audit --omit=dev`: **0 vulnerabilities**.
- `cargo audit`: **not measured** — cargo-audit not installed in this env.

## Verified OK (audited, no fix needed)

| Area | Evidence |
|---|---|
| Project save | `store::save` writes tmp sibling + rename — atomic; crash leaves prior file |
| Shell injection | All child processes use `Command::arg()` (ffmpeg, explorer `/select,`) — no shell strings |
| Job cancellation | `ctx.is_cancelled()` checked in render loop; ffmpeg child killed on cancel; partial outputs `remove_file`'d |
| Analytics import | 10 MiB cap + 50k row cap; values bound via rusqlite params; source tagged |
| OAuth | loopback non-blocking + 3-min deadline, PKCE S256, state nonce; tokens only in Authorization headers, vault = keyring |
| Audio preview | single `AudioContext` + WeakMap chains — no per-clip context leak |
| Render filtergraph | drawtext/subtitles paths escaped (`text.rs`, plan.rs:990/1098) |
| Capabilities | only `core:default` + `dialog:default` — tight |
| Logs | log plugin to LogDir+Stdout; no token/secret strings in code paths |

## Findings

### H1 — No CSP (HIGH, security)
`tauri.conf.json → security.csp: null`. Any markup injection (e.g. crafted
project/media name rendered unsanitized) gets full DOM + IPC.
- Fix: strict CSP — `default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: data:; media-src 'self' asset: blob:; style-src 'self' 'unsafe-inline'` (inline styles used for timeline positioning — required).

### H2 — assetProtocol scope `["**"]` (HIGH→documented risk)
Webview can `convertFileSrc` any path on disk. Required: users import media
from arbitrary locations. Kept by design; mitigated by H1 CSP + React's
default escaping (no `dangerouslySetInnerHTML` in codebase — verified).
Residual risk documented in SECURITY.md.

### M1 — Monolithic 684 kB bundle (MED, perf)
All modules eager in `App.tsx`. Editor+social+analytics are the heavy
subtrees.
- Fix: `React.lazy` per module + Suspense fallback; keep shell+home eager.
- Expected: initial chunk ~120–200 kB; per-module chunks 50–250 kB.

### M2 — TimelinePanel re-renders at rAF rate (MED, perf)
`useEditor(s => s.playheadMs)` subscription in the 565-line timeline
component → full re-render ~60×/s during playback (rAF master clock in
Preview). Snap points recomputed each frame too.
- Repro: play a project, React DevTools profiler shows TimelinePanel
  render per frame.
- Fix: extract `PlayheadOverlay` (line + timecode) subscribing to
  playheadMs; parent reads `useEditor.getState().playheadMs` inside
  event handlers (split, snap) instead of subscribing.
- Expected: timeline renders only on edit/selection/zoom changes.

### M3 — Stale 'running' jobs never swept (MED, reliability)
`jobs` table inserts 'running'; comment says "detectable on next launch"
but no startup sweep exists — crash leaves phantom running jobs forever.
- Fix: `UPDATE jobs SET status='interrupted' WHERE status='running'` in setup.

### L1 — Unused dep `@tauri-apps/plugin-fs` (LOW)
In package.json, zero imports, no capability, no rust plugin. Remove.

### L2 — No size cap on `.creatora` open (LOW)
`store::open` read_to_string + parse any size. Malformed giant file →
memory spike. Fix: reject files > 64 MiB (real projects are KB–low MB).

### L3 — Disk caches unbounded (LOW, documented)
Thumbnails/proxies/waveforms keyed by (path,mtime) under app_data —
unbounded growth, but content-addressed and small. Rationale documented;
no arbitrary cap added (requirement: no undocumented limits).

### L4 — cargo-audit unavailable (LOW, process)
Not installed; Cargo.lock not scanned. Recorded for Phase 11 toolchain.

## Plan of record
Implement H1, M1, M2, M3, L1, L2; document H2, L3, L4. Each fix gets a
test or reproducible verification (build chunk table, clippy/test gates,
job-sweep integration test, size-cap unit test).
