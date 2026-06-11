-- Global chat ("Grails Chat"): a single well-known chats row with type 'global'.
-- No chat_participants rows are ever created for it; access control and WS
-- fan-out are handled in the app by comparing against the fixed UUID below
-- (GLOBAL_CHAT_ID in services/api/src/services/global-chat.ts).
-- Created: 2026-06-10

ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_type_check;
ALTER TABLE chats ADD CONSTRAINT chats_type_check
  CHECK (type IN ('direct', 'group', 'global'));

-- The global room has no creator.
ALTER TABLE chats ALTER COLUMN created_by_user_id DROP NOT NULL;

INSERT INTO chats (id, type, title, dm_key, created_by_user_id)
VALUES ('00000000-0000-0000-0000-000000000001', 'global', 'Grails Chat', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Supports the per-sender daily quota COUNT in the global send path.
CREATE INDEX IF NOT EXISTS idx_messages_chat_sender_created
  ON messages(chat_id, sender_user_id, created_at DESC);
