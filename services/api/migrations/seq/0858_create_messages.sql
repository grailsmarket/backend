-- Migration: Create messages table and back-fill chat_participants FK
-- v1 supports text only. metadata JSONB and content_type are reserved for
-- future attachments / link previews / etc. Soft delete via deleted_at.
-- Created: 2026-04-28

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_user_id  INTEGER NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  content_type    VARCHAR(16) NOT NULL DEFAULT 'text'
                    CHECK (content_type IN ('text')),
  metadata        JSONB,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMP,
  deleted_at      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created
  ON messages(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages(sender_user_id, created_at DESC);

-- Now that messages exists, attach the FK from chat_participants.last_read_message_id
ALTER TABLE chat_participants
  DROP CONSTRAINT IF EXISTS chat_participants_last_read_fk;

ALTER TABLE chat_participants
  ADD CONSTRAINT chat_participants_last_read_fk
  FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL;

COMMENT ON TABLE messages IS 'Chat messages (one row per send)';
COMMENT ON COLUMN messages.body IS 'Plain text body, 1–4000 chars enforced at app layer';
COMMENT ON COLUMN messages.content_type IS 'Currently only "text"; widen via DROP+ADD CONSTRAINT when adding media';
COMMENT ON COLUMN messages.deleted_at IS 'Soft-delete; sender can delete their own messages';
