-- Migration: Create chat_participants table
-- One row per (chat, user). Tracks per-user state within a chat: read position,
-- mute status, soft-leave (group only), and role (member/admin for group ops).
-- Created: 2026-04-28

CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id              UUID    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  joined_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at              TIMESTAMP,
  role                 VARCHAR(16) NOT NULL DEFAULT 'member'
                         CHECK (role IN ('member', 'admin')),
  last_read_message_id UUID,
  muted                BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user
  ON chat_participants(user_id);

COMMENT ON TABLE chat_participants IS 'Per-user membership and state within a chat';
COMMENT ON COLUMN chat_participants.left_at IS 'Soft-leave timestamp; preserves history for the leaver';
COMMENT ON COLUMN chat_participants.last_read_message_id IS 'Most recent message this user has acknowledged reading';
COMMENT ON COLUMN chat_participants.muted IS 'Per-chat notification mute (does not stop delivery)';
