ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;
CREATE INDEX idx_users_last_seen_at ON users(last_seen_at DESC) WHERE last_seen_at IS NOT NULL;
