CREATE TABLE IF NOT EXISTS profile_views (
  id SERIAL PRIMARY KEY,
  profile_address VARCHAR(42) NOT NULL,
  viewer_identifier VARCHAR(255) NOT NULL,
  viewer_type VARCHAR(20) NOT NULL DEFAULT 'authenticated',
  viewed_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_profile_view UNIQUE(profile_address, viewer_identifier),
  CONSTRAINT valid_profile_viewer_type CHECK (viewer_type IN ('authenticated', 'anonymous'))
);

CREATE INDEX idx_profile_views_address ON profile_views(profile_address);
CREATE INDEX idx_profile_views_identifier ON profile_views(viewer_identifier);
CREATE INDEX idx_profile_views_viewed_at ON profile_views(viewed_at DESC);
