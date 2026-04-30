-- Migration: Add messaging preference columns to users table
-- accept_messages: hard block on inbound messages when FALSE (sender gets 403)
-- is_stub: marks placeholder users created by the chat system before SIWE sign-in
-- Created: 2026-04-28

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS accept_messages BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_stub          BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.accept_messages IS 'When FALSE, this user will not accept new chat messages — senders get 403';
COMMENT ON COLUMN users.is_stub IS 'TRUE for users auto-created by the chat system before they have signed in via SIWE; cleared on first successful auth';
