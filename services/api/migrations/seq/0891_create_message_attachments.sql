-- Image attachments for chat messages. One row per uploaded image (MVP = one
-- image per message; the shape allows more later). storage_key references an
-- object in the Railway S3-compatible bucket (config.storage). created_at +
-- expired_at drive the 180-day image-expiry worker: once the bucket object is
-- deleted, expired_at is stamped and the message itself is left intact.
-- Created: 2026-06-17

CREATE TABLE IF NOT EXISTS message_attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    -- Denormalized from messages.chat_id so the serving route can enforce
    -- per-chat read access and the workers can scope without an extra join.
    chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    storage_key  TEXT        NOT NULL,
    content_type VARCHAR(64) NOT NULL,
    byte_size    INTEGER     NOT NULL,
    width        INTEGER,
    height       INTEGER,
    created_at   TIMESTAMP   NOT NULL DEFAULT NOW(),
    -- Set by the image-expiry worker once the bucket object has been deleted.
    expired_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_msg_attach_message ON message_attachments (message_id);
-- Partial index drives the expiry-worker scan (only not-yet-expired rows, by age).
CREATE INDEX IF NOT EXISTS idx_msg_attach_live_age
  ON message_attachments (created_at) WHERE expired_at IS NULL;
-- Lookup by storage_key for the serving proxy (expiry/access check per request).
CREATE INDEX IF NOT EXISTS idx_msg_attach_storage_key ON message_attachments (storage_key);
