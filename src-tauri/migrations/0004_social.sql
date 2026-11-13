-- 0004_social.sql — Phase 8: Social Studio data model (ADR-028)
--
-- Local-first: a post exists without any connected account. Accounts only
-- gate real publishing. `social_accounts` and the older `publications`
-- table from 0001 are superseded by social_post_targets /
-- publication_attempts below (publications kept for compat, unused).

CREATE TABLE social_posts (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title         TEXT NOT NULL DEFAULT '',
  caption       TEXT NOT NULL DEFAULT '',
  hashtags_json TEXT NOT NULL DEFAULT '[]',
  thumbnail_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','ready','scheduled','publishing','published','failed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_social_posts_status   ON social_posts(status);
CREATE INDEX idx_social_posts_project  ON social_posts(project_id);

-- One row per platform the post targets. Own caption/title/hashtags so a
-- single post can diverge per platform without touching shared text.
CREATE TABLE social_post_targets (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK(platform IN ('youtube','tiktok','instagram','facebook')),
  account_id    TEXT REFERENCES social_accounts(id) ON DELETE SET NULL,
  version_id    TEXT,                  -- FormatVersion to export (NULL = base)
  export_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  title         TEXT,                  -- NULL = inherit post.title
  caption       TEXT,                  -- NULL = inherit post.caption
  hashtags_json TEXT,                  -- NULL = inherit post.hashtags_json
  platform_meta_json TEXT NOT NULL DEFAULT '{}',  -- per-platform opts (privacy, page…)
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','ready','scheduled','publishing','published','failed','cancelled')),
  scheduled_at  TEXT,
  auto_publish  INTEGER NOT NULL DEFAULT 0,  -- 1 = attempt real upload at due time
  platform_post_id TEXT,
  platform_url  TEXT,
  last_error    TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, platform, version_id)
);
CREATE INDEX idx_spt_post     ON social_post_targets(post_id);
CREATE INDEX idx_spt_due      ON social_post_targets(scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX idx_spt_platform ON social_post_targets(platform);

-- Every publish attempt is recorded — Published only when the platform
-- API returned a real post id/url. Never trust client state.
CREATE TABLE publication_attempts (
  id            TEXT PRIMARY KEY,
  target_id     TEXT NOT NULL REFERENCES social_post_targets(id) ON DELETE CASCADE,
  job_id        TEXT,
  status        TEXT NOT NULL CHECK(status IN ('uploading','published','failed','cancelled')),
  platform_post_id TEXT,
  platform_url  TEXT,
  error         TEXT,
  attempt_no    INTEGER NOT NULL DEFAULT 1,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX idx_attempts_target ON publication_attempts(target_id);

-- Caption Studio: saved description templates + hashtag usage memory.
CREATE TABLE caption_templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  body         TEXT NOT NULL,
  hashtags_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE hashtag_history (
  tag         TEXT PRIMARY KEY COLLATE NOCASE,
  uses        INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- social_accounts (0001) stays: platform/platform_user_id/display_name/
-- scopes_json/status/token_expires_at already fit. Credentials never live
-- in SQLite — the OS vault (Windows Credential Manager via keyring) holds
-- them, keyed `creatora.social.<account_id>`.
