-- Ordering for multi-image messages. A message can now carry up to N images
-- (cap enforced in the API); `position` gives them a stable client-facing order
-- independent of created_at tie-breaks. Existing single-image rows default to 0.
-- Created: 2026-06-18

ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS position SMALLINT NOT NULL DEFAULT 0;
