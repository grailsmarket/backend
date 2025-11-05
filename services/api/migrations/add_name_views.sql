-- Migration: Add name view tracking
-- Description: Track unique authenticated user views for each ENS name
-- Author: Claude
-- Date: 2025-01-11

-- Create name_views table for tracking individual views
CREATE TABLE IF NOT EXISTS name_views (
  id SERIAL PRIMARY KEY,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  viewer_identifier VARCHAR(255) NOT NULL, -- user_id for authenticated users
  viewer_type VARCHAR(20) NOT NULL DEFAULT 'authenticated',
  viewed_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_name_view UNIQUE(ens_name_id, viewer_identifier),
  CONSTRAINT valid_viewer_type CHECK (viewer_type IN ('authenticated', 'anonymous'))
);

-- Create indexes for fast lookups
CREATE INDEX idx_name_views_name ON name_views(ens_name_id);
CREATE INDEX idx_name_views_identifier ON name_views(viewer_identifier);
CREATE INDEX idx_name_views_viewed_at ON name_views(viewed_at DESC);

-- Add view_count column to ens_names for quick access
ALTER TABLE ens_names ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;

-- Create index for sorting by popularity
CREATE INDEX IF NOT EXISTS idx_ens_names_view_count ON ens_names(view_count DESC);

-- Add comments for documentation
COMMENT ON TABLE name_views IS 'Tracks unique views of ENS names by authenticated users';
COMMENT ON COLUMN name_views.ens_name_id IS 'Reference to the ENS name that was viewed';
COMMENT ON COLUMN name_views.viewer_identifier IS 'User ID (from users table) for authenticated viewers';
COMMENT ON COLUMN name_views.viewer_type IS 'Type of viewer: authenticated or anonymous';
COMMENT ON COLUMN name_views.viewed_at IS 'Timestamp when the name was first viewed by this user';

COMMENT ON COLUMN ens_names.view_count IS 'Cached count of unique authenticated users who have viewed this name';

-- Optional: Create a trigger to automatically increment view_count
-- This ensures view_count stays in sync even if updated manually
CREATE OR REPLACE FUNCTION increment_name_view_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ens_names
  SET view_count = view_count + 1
  WHERE id = NEW.ens_name_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_name_view_insert
AFTER INSERT ON name_views
FOR EACH ROW
EXECUTE FUNCTION increment_name_view_count();

-- Optional: Create a function to get view count for a specific name
CREATE OR REPLACE FUNCTION get_name_view_count(name_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
  view_cnt INTEGER;
BEGIN
  SELECT view_count INTO view_cnt FROM ens_names WHERE id = name_id;
  RETURN COALESCE(view_cnt, 0);
END;
$$ LANGUAGE plpgsql;
