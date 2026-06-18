-- Widen messages.content_type to allow image messages. The 0858 migration left
-- a note to do exactly this "via DROP+ADD CONSTRAINT when adding media".
-- Created: 2026-06-17

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_type_check;
ALTER TABLE messages ADD  CONSTRAINT messages_content_type_check
  CHECK (content_type IN ('text', 'image'));
