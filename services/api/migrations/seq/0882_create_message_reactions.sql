-- Emoji reactions on chat messages (DMs and global chat). One row per
-- (message, user, emoji); emoji is the literal grapheme (ZWJ sequences and
-- skin tones can be long, hence 32 chars).
-- Created: 2026-06-10

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       VARCHAR(32) NOT NULL,
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- The PK serves message-prefix lookups (aggregation); this covers per-user paths.
CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);
