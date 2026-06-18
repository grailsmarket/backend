-- Chat-image controls, stored alongside the rest of the chat config so the admin
-- moderation panel has a single place to tune them.
--   images_enabled         - master kill switch for image sending in ALL chats
--   message_retention_days  - GLOBAL chat only: hard-delete messages older than this
--   image_retention_days    - ALL chats: expire (delete from bucket) images older than this
-- Created: 2026-06-17

ALTER TABLE global_chat_config
  ADD COLUMN IF NOT EXISTS images_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS message_retention_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS image_retention_days   INTEGER NOT NULL DEFAULT 180;
