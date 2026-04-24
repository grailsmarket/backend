CREATE TABLE dashboard_layouts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  grid_columns VARCHAR(4) NOT NULL DEFAULT 'auto',
  panels JSONB NOT NULL DEFAULT '[]',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name),
  CONSTRAINT valid_grid_columns CHECK (grid_columns IN ('auto', '1', '2', '3', '4'))
);

CREATE INDEX idx_dashboard_layouts_user_id ON dashboard_layouts(user_id);

-- Partial unique index: at most one default dashboard per user
CREATE UNIQUE INDEX idx_dashboard_layouts_user_default
  ON dashboard_layouts(user_id) WHERE is_default = TRUE;

CREATE TRIGGER update_dashboard_layouts_updated_at
  BEFORE UPDATE ON dashboard_layouts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
