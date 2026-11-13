# DATABASE_SCHEMA.md — Creatora

SQLite database: `%APPDATA%/Creatora/creatora.db` (path configurable in Settings).
Access: `rusqlite` (bundled SQLite) behind a `Mutex<Connection>` owned by `db::Db` in Tauri state.
Migrations: numbered `.sql` files in `src-tauri/migrations/`, applied in order inside transactions; `PRAGMA user_version` = applied count. Foreign keys ON. WAL journal mode.

## Schema v1

### projects
```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,          -- uuid v4
  name          TEXT NOT NULL,
  file_path     TEXT NOT NULL UNIQUE,      -- absolute path to .creatora
  thumbnail_path TEXT,
  width         INTEGER, height INTEGER,
  fps_num       INTEGER, fps_den INTEGER,
  duration_ms   INTEGER,
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  is_archived   INTEGER NOT NULL DEFAULT 0,
  source_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, -- derived versions
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_opened_at TEXT
);
CREATE INDEX idx_projects_modified ON projects(modified_at DESC);
```

### media_assets
```sql
CREATE TABLE media_assets (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN ('video','audio','image','graphic','font','template','project')),
  file_path    TEXT NOT NULL UNIQUE,
  file_hash    TEXT,                       -- xxhash64 for duplicate detection
  file_size    INTEGER,
  name         TEXT NOT NULL,
  width        INTEGER, height INTEGER,
  duration_ms  INTEGER,
  fps_num      INTEGER, fps_den INTEGER,
  codec        TEXT, audio_codec TEXT,
  thumbnail_path TEXT, proxy_path TEXT,
  status       TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','missing','processing')),
  metadata_json TEXT,                      -- ffprobe extras
  imported_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assets_kind ON media_assets(kind);
CREATE INDEX idx_assets_hash ON media_assets(file_hash);
```

*Migration 0002 adds:* `is_favorite INTEGER NOT NULL DEFAULT 0` on `media_assets`.

### collections + asset_collection
```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES collections(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE asset_collection (
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY(asset_id, collection_id)
);
```

### tags + asset_tag
```sql
CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE asset_tag (
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(asset_id, tag_id)
);
```

### project_asset (usage references)
```sql
CREATE TABLE project_asset (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id, asset_id)
);
```

### brand_kits
```sql
CREATE TABLE brand_kits (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  palette_json TEXT, fonts_json TEXT, logos_json TEXT,
  presets_json TEXT,                       -- lower thirds, watermarks, intros...
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### social_accounts
```sql
CREATE TABLE social_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('youtube','tiktok','instagram','facebook')),
  platform_user_id TEXT NOT NULL,
  display_name TEXT, avatar_url TEXT,
  scopes_json TEXT,                        -- granted scopes; tokens are NOT here (keyring)
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked','error')),
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_expires_at TEXT,
  UNIQUE(platform, platform_user_id)
);
```

### publications  (one row = one post on one platform for one version)
```sql
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  title TEXT, caption TEXT, metadata_json TEXT,   -- tags, privacy, thumbnail path...
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','scheduled','uploading','published','failed','cancelled')),
  scheduled_at TEXT, published_at TEXT,
  platform_post_id TEXT, platform_url TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pub_sched ON publications(scheduled_at) WHERE status='scheduled';
CREATE INDEX idx_pub_project ON publications(project_id);
```

### export_jobs (history; live queue is in-memory)
```sql
CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  profile_json TEXT NOT NULL, output_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
  error TEXT, duration_ms INTEGER, file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
```

### analytics_snapshots (cached metrics pulled via API)
```sql
CREATE TABLE analytics_snapshots (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  metrics_json TEXT NOT NULL               -- {views,likes,comments,...} as exposed by API
);
```

### settings (app-level KV; UI mirrors to zustand)
```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

### jobs (durable job log for crash recovery)
```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT
);
```

## Migration policy

- File naming: `NNNN_name.sql` starting at `0001_init.sql`.
- Migrations run at app start before any query; wrapped in a transaction each.
- Never edit an applied migration. New change = new file.
- `.creatora` project files carry their own `format_version` and a separate migration chain in `src-tauri/src/project/migrations.rs`.
