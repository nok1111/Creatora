-- Phase 10.5: account-level metric snapshots (followers, subscribers…)
-- Distinct from metric_snapshots: these belong to an *account*, not a post.
-- Provenance identical: source ∈ api|import, append-only, one row per
-- (account, source, day) — never fabricate history before first sync.

CREATE TABLE account_snapshots (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
  source       TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','import','local')),
  metrics_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_acct_snap ON account_snapshots(account_id, fetched_at);
CREATE UNIQUE INDEX idx_acct_snap_dedupe ON account_snapshots(
  account_id, source, date(fetched_at));
