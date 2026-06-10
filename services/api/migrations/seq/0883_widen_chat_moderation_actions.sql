-- Widen chat_moderation_log.action for global chat moderation:
--   delete_message - single message soft-deleted by an admin
--   config_update  - global_chat_config changed via admin panel
-- Created: 2026-06-10

ALTER TABLE chat_moderation_log DROP CONSTRAINT IF EXISTS chat_moderation_log_action_check;
ALTER TABLE chat_moderation_log ADD CONSTRAINT chat_moderation_log_action_check
  CHECK (action IN ('ban', 'unban', 'delete_messages', 'delete_message', 'config_update'));
