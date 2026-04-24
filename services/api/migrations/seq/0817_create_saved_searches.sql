CREATE TABLE saved_searches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  query TEXT,
  filters JSONB NOT NULL DEFAULT '{}',
  sort_by VARCHAR(40),
  sort_order VARCHAR(4),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name),
  CONSTRAINT valid_sort_order CHECK (sort_order IS NULL OR sort_order IN ('asc', 'desc'))
);

CREATE INDEX idx_saved_searches_user_id ON saved_searches(user_id);

CREATE UNIQUE INDEX idx_saved_searches_user_default
  ON saved_searches(user_id) WHERE is_default = TRUE;

CREATE TRIGGER update_saved_searches_updated_at
  BEFORE UPDATE ON saved_searches
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
