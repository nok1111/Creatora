-- 0002_asset_favorites.sql — favorite flag on library assets

ALTER TABLE media_assets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
