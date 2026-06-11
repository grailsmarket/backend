-- Supports GET /api/v1/chats/global/online-users (recently signed-in users
-- ordered by last_sign_in DESC within a 24h window).
-- Created: 2026-06-10

CREATE INDEX IF NOT EXISTS idx_users_last_sign_in
  ON users(last_sign_in DESC) WHERE last_sign_in IS NOT NULL;
