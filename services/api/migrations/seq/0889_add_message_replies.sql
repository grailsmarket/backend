-- Threaded replies: a message may reference the message it replies to.
--
-- ON DELETE SET NULL so deleting a parent doesn't cascade-delete replies; the
-- reply just loses its parent reference (the UI shows "replying to a deleted
-- message"). Self-referential FK to messages(id).
-- Created: 2026-06-16

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- Supports the parent-preview LEFT JOIN on reads/broadcasts; partial since most
-- messages are not replies.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
