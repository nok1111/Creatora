-- 0005_analytics.sql — Phase 9: analytics, insights & publish packets (ADR-029)
--
-- metric_snapshots is a time series: every sync/import appends a row,
-- never overwrites. `source` is mandatory on every row — api / import /
-- local — so dashboards can never blend provenances silently.

CREATE TABLE metric_snapshots (
  id           TEXT PRIMARY KEY,
  target_id    TEXT NOT NULL REFERENCES social_post_targets(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  remote_id    TEXT,                 -- platform_post_id (NULL when unknown)
  period       TEXT NOT NULL DEFAULT 'lifetime',  -- lifetime|day|7d|28d|custom range
  source       TEXT NOT NULL CHECK(source IN ('api','import','local')),
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
  batch_id     TEXT,                 -- import_batches.id when source='import'
  metrics_json TEXT NOT NULL         -- [{key,label,unit,value}]
);
CREATE INDEX idx_snap_target  ON metric_snapshots(target_id);
CREATE INDEX idx_snap_remote  ON metric_snapshots(platform, remote_id);
CREATE INDEX idx_snap_fetched ON metric_snapshots(fetched_at);
-- Dedupe guard: one row per (target, period, source, day fetched).
CREATE UNIQUE INDEX idx_snap_dedupe ON metric_snapshots(
  target_id, period, source, date(fetched_at));

-- One row per sync execution (manual or scheduled) — the audit trail.
CREATE TABLE analytics_sync_runs (
  id            TEXT PRIMARY KEY,
  trigger_kind  TEXT NOT NULL CHECK(trigger_kind IN ('manual','scheduled')),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','ok','partial','failed','cancelled')),
  targets_total INTEGER NOT NULL DEFAULT 0,
  targets_ok    INTEGER NOT NULL DEFAULT 0,
  targets_failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sync_runs_started ON analytics_sync_runs(started_at);

CREATE TABLE analytics_sync_errors (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES analytics_sync_runs(id) ON DELETE CASCADE,
  target_id  TEXT REFERENCES social_post_targets(id) ON DELETE SET NULL,
  platform   TEXT,
  error      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sync_err_run ON analytics_sync_errors(run_id);

-- Manual CSV/JSON imports — the batch is the provenance record.
CREATE TABLE import_batches (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  format        TEXT NOT NULL CHECK(format IN ('csv','json')),
  source_label  TEXT NOT NULL,        -- user-supplied origin description
  rows_seen     INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  errors_json   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Publish packets: folders on disk; this row is the registry so the UI
-- can list/regenerate without rescanning the filesystem.
CREATE TABLE publish_packets (
  id         TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL REFERENCES social_post_targets(id) ON DELETE CASCADE,
  dir_path   TEXT NOT NULL,
  files_json TEXT NOT NULL,           -- ["video.mp4","thumbnail.jpg",…]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_packets_target ON publish_packets(target_id);
