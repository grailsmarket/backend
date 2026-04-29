-- Migration: Create message_blocks table
-- A user can block specific other users from sending them messages. Blocks are
-- one-directional: blocker → blocked. Enforced at send time (POST /chats and
-- POST /chats/:id/messages return 403 if either party has blocked the other).
-- Created: 2026-04-28

CREATE TABLE IF NOT EXISTS message_blocks (
  blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_blocks_blocked
  ON message_blocks(blocked_user_id);

COMMENT ON TABLE message_blocks IS 'Per-user block list for chat messages';
