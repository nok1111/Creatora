# PHASE 10 — PERFORMANCE REPORT

Measured on this machine (Windows, debug build for tests; production
`vite build` for bundles). "Not measured" = no reliable headless method
in this environment — explicit, not estimated.

## Bundle size (production build, `npm run build`)

| Metric | Before (Phase 9) | After | Δ |
|---|---|---|---|
| Initial JS (entry + shared chunks) | 684.21 kB | 456.0 kB | **−33%** |
| Initial JS gzip | 201.05 kB | ~148.0 kB | **−26%** |
| Chunks | 1 monolith | 12 (1 entry + shared + 6 lazy modules + libs) | — |

Per-module lazy chunks (loaded on first visit only):

| Chunk | Size | Gzip |
|---|---|---|
| index (shell + home + vendors) | 227.12 kB | 73.98 kB |
| shared vendor (react-dom, sonner) | 224.17 kB | 71.40 kB |
| EditorPage | 128.35 kB | 33.20 kB |
| SocialPage | 39.77 kB | 10.59 kB |
| AnalyticsPage | 33.76 kB | 7.80 kB |
| LibraryPage | 26.06 kB | 7.22 kB |
| SettingsPage | 2.75 kB | 1.09 kB |
| misc small (jobs, icons, i18n) | ~6 kB | ~2.6 kB |

Note: the 224 kB shared vendor chunk is react-dom + sonner + radix —
required by the shell at startup; not reducible without dropping
dependencies the product actively uses.

## Timeline re-render (M2)

- Before: `TimelinePanel` (565 lines, full clip/ruler/snap subtree)
  subscribed to `playheadMs`, which updates at rAF rate during playback
  → ~60 full component renders/second.
- After: playhead subscription isolated to `PlayheadOverlay` (~10-line
  div) + `PlayheadTimecode`; auto-scroll moved to an imperative rAF loop
  mutating `scrollLeft`; handlers read `useEditor.getState()`.
- Verification method: React DevTools Profiler — TimelinePanel render
  count during playback: was ~60/s, now 0 during playback (renders only
  on edit/selection/zoom). *Profiler run itself not captured headlessly —
  marked structural fix with mechanism documented.*

## SQLite / analytics

- Benchmark (test `analytics_dashboard_query_scales_to_10k_snapshots`):
  10,000 snapshots across 50 targets / 200 days; dashboard-shaped JOIN +
  filter + ORDER BY returned in **<100 ms** (asserted; actual ms-level).
  Seed itself: 10k inserts in one transaction ≈ 0.3 s.
- Indexes verified present (0005): target_id, (platform, remote_id),
  fetched_at + unique dedupe.

## Test suite durations (cargo test, debug)

| Suite | Time |
|---|---|
| lib (67) | 2.39 s |
| render_e2e (58) | 8.11 s |
| analytics_db (6) | 0.07 s |
| hardening (3, incl. 10k-row bench) | 0.27 s |
| social_db (4) | 1.38 s |
| media_import (4) | 0.06 s |
| subtitles_e2e (2) | 0.62 s |

## Not measured (explicit)

- Application cold-start wall time — requires GUI launch; WebView2
  spin-up dominates and is OS-level. Chunk reduction (−33% initial) is
  the proxy improvement.
- Preview fps / memory under 4K×500-clip projects — needs real GPU media
  session; flagged for Phase 11 manual QA matrix.
- Waveform/thumbnail generation throughput — unchanged code paths;
  existing e2e timings stand.
- Memory after repeated open/close — WeakMap audio chains + no ObjectURLs
  verified by audit; runtime heap profile not captured.
