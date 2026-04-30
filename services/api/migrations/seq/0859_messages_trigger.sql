-- Migration: AFTER INSERT trigger on messages
-- 1. Updates chats.last_message_at (denormalized inbox sort key)
-- 2. Emits pg_notify('chat_message_created', {message_id, chat_id}) so the
--    in-process ChatNotifier can fan out to WebSocket clients.
--
-- Mirrors the LISTEN/NOTIFY pattern used by activity-notifier.ts.
-- Created: 2026-04-28

CREATE OR REPLACE FUNCTION notify_chat_message_created()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chats
     SET last_message_at = NEW.created_at
   WHERE id = NEW.chat_id;

  PERFORM pg_notify(
    'chat_message_created',
    json_build_object(
      'message_id', NEW.id,
      'chat_id',    NEW.chat_id
    )::text
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_message_created_trigger ON messages;
CREATE TRIGGER chat_message_created_trigger
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_chat_message_created();
