-- Migration: Add Telegram notification support
-- Adds telegram_connected and telegram_chat_id to users table
-- Creates telegram_verification_codes table for the /reg flow

-- Add Telegram connection tracking to users
ALTER TABLE users
ADD COLUMN IF NOT EXISTS telegram_connected BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

-- Create telegram verification codes table
CREATE TABLE IF NOT EXISTS telegram_verification_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(16) NOT NULL,
  telegram_username VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_at TIMESTAMPTZ
);

-- Index for code lookups (only unused codes)
CREATE INDEX IF NOT EXISTS idx_telegram_verification_codes_code
  ON telegram_verification_codes(code)
  WHERE used_at IS NULL;

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_telegram_verification_codes_user_id
  ON telegram_verification_codes(user_id);

-- Comments
COMMENT ON COLUMN users.telegram_connected IS 'Whether Telegram account has been verified via bot /reg command';
COMMENT ON COLUMN users.telegram_chat_id IS 'Telegram chat ID for sending notifications (set during /reg verification)';
COMMENT ON TABLE telegram_verification_codes IS 'Short-lived codes for connecting Telegram accounts via the bot';
