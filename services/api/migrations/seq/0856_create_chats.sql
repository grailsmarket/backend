-- Migration: Create chats table
-- A chat is a thread between two or more users. v1 only creates 'direct' chats
-- (1:1), but the schema supports 'group' for future expansion.
--
-- dm_key is a deterministic identifier for direct chats:
--     least(user_a_id, user_b_id) || ':' || greatest(user_a_id, user_b_id)
-- The unique constraint makes "find-or-create direct chat" idempotent under
-- concurrent inserts. Group chats have dm_key = NULL.
-- Created: 2026-04-28

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chats (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type               VARCHAR(16) NOT NULL DEFAULT 'direct'
                       CHECK (type IN ('direct', 'group')),
  title              VARCHAR(120),
  dm_key             VARCHAR(80) UNIQUE,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  last_message_at    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chats_last_message_at
  ON chats(last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_chats_created_by_user_id
  ON chats(created_by_user_id);

COMMENT ON TABLE chats IS 'Chat threads (direct messages and future group chats)';
COMMENT ON COLUMN chats.type IS 'direct (1:1) or group (multi-party, not used in v1)';
COMMENT ON COLUMN chats.title IS 'Display title; only meaningful for group chats';
COMMENT ON COLUMN chats.dm_key IS 'Deterministic key for direct chats (sorted user-id pair); NULL for groups';
COMMENT ON COLUMN chats.last_message_at IS 'Denormalized for inbox sort; updated by trigger on messages insert';
