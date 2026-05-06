-- Chat moderation: admin tools to ban a user from messaging and audit log.
-- Mirrors comment_user_status / comment_moderation_log (schema.sql:253-307) but minimal:
-- only active/banned (no warn/suspend escalation), single bulk delete-messages action.

CREATE TABLE IF NOT EXISTS chat_user_status (
    user_id              INTEGER PRIMARY KEY,
    status               VARCHAR(16) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'banned')),
    banned_at            TIMESTAMP,
    last_action_by       INTEGER,
    last_action_reason   TEXT,
    updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_moderation_log (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER,
    admin_id     INTEGER,
    action       VARCHAR(32) NOT NULL
                   CHECK (action IN ('ban', 'unban', 'delete_messages')),
    reason       TEXT,
    metadata     JSONB,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_moderation_log_user
  ON chat_moderation_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_moderation_log_admin
  ON chat_moderation_log(admin_id, created_at DESC);
