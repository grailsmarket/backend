-- Global-chat-scoped bans + configurable global chat send rate limit.
--
-- chat_user_status.global_status is independent of `status` (the all-chats
-- ban): a user can be banned from global chat only (DMs keep working), from
-- all chats, or both. The global send/reaction paths check
-- (status = 'banned' OR global_status = 'banned'); DM paths check only
-- `status` as before.
-- Created: 2026-06-11

ALTER TABLE chat_user_status
  ADD COLUMN IF NOT EXISTS global_status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (global_status IN ('active', 'banned'));
ALTER TABLE chat_user_status
  ADD COLUMN IF NOT EXISTS global_banned_at TIMESTAMP;

ALTER TABLE chat_moderation_log DROP CONSTRAINT IF EXISTS chat_moderation_log_action_check;
ALTER TABLE chat_moderation_log ADD CONSTRAINT chat_moderation_log_action_check
  CHECK (action IN ('ban', 'unban', 'delete_messages', 'delete_message', 'config_update',
                    'global_ban', 'global_unban'));

-- Per-user per-minute send rate limit on POST /chats/global/messages
-- (distinct from the daily quota tiers). 10 matches the previously
-- hardcoded value.
ALTER TABLE global_chat_config
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER NOT NULL DEFAULT 10;
