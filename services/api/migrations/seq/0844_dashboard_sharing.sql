-- Shareable dashboards: public visibility, share slugs, view + fork tracking.

-- 1. New columns on dashboard_layouts
ALTER TABLE dashboard_layouts
  ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN public_slug VARCHAR(16) UNIQUE,
  ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN fork_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN forked_from_id INTEGER REFERENCES dashboard_layouts(id) ON DELETE SET NULL,
  ADD COLUMN published_at TIMESTAMPTZ;

CREATE INDEX idx_dashboard_layouts_public_slug
  ON dashboard_layouts(public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX idx_dashboard_layouts_is_public
  ON dashboard_layouts(is_public) WHERE is_public = TRUE;
CREATE INDEX idx_dashboard_layouts_forked_from
  ON dashboard_layouts(forked_from_id) WHERE forked_from_id IS NOT NULL;

-- 2. dashboard_views — mirrors name_views / profile_views pattern
CREATE TABLE dashboard_views (
  id SERIAL PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboard_layouts(id) ON DELETE CASCADE,
  viewer_identifier VARCHAR(255) NOT NULL,
  viewer_type VARCHAR(20) NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(dashboard_id, viewer_identifier),
  CONSTRAINT valid_dashboard_viewer_type CHECK (viewer_type IN ('authenticated','anonymous'))
);

CREATE INDEX idx_dashboard_views_dashboard ON dashboard_views(dashboard_id);
CREATE INDEX idx_dashboard_views_viewed_at ON dashboard_views(viewed_at DESC);

CREATE OR REPLACE FUNCTION increment_dashboard_view_count() RETURNS trigger AS $$
BEGIN
  UPDATE dashboard_layouts
  SET view_count = view_count + 1, updated_at = NOW()
  WHERE id = NEW.dashboard_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_dashboard_view_insert
AFTER INSERT ON dashboard_views
FOR EACH ROW EXECUTE FUNCTION increment_dashboard_view_count();

-- 3. dashboard_forks — audit log + fork_count trigger
CREATE TABLE dashboard_forks (
  id SERIAL PRIMARY KEY,
  parent_dashboard_id INTEGER NOT NULL REFERENCES dashboard_layouts(id) ON DELETE CASCADE,
  child_dashboard_id INTEGER NOT NULL REFERENCES dashboard_layouts(id) ON DELETE CASCADE,
  forker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(child_dashboard_id)
);

CREATE INDEX idx_dashboard_forks_parent ON dashboard_forks(parent_dashboard_id);
CREATE INDEX idx_dashboard_forks_forker ON dashboard_forks(forker_user_id);

CREATE OR REPLACE FUNCTION increment_dashboard_fork_count() RETURNS trigger AS $$
BEGIN
  UPDATE dashboard_layouts
  SET fork_count = fork_count + 1, updated_at = NOW()
  WHERE id = NEW.parent_dashboard_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_dashboard_fork_insert
AFTER INSERT ON dashboard_forks
FOR EACH ROW EXECUTE FUNCTION increment_dashboard_fork_count();
