-- Migration: notification preferences for the comments feature
-- Created: 2026-05-01
--
-- - users.notify_on_comment_received: opt-out toggle for "your owned name received
--   a comment" notifications. Default TRUE so existing users get notified once
--   the feature ships, matching the pattern set by notify_on_offer_received.
-- - watchlist.notify_on_comment: per-watchlist-entry toggle for comments on
--   watched names. Default FALSE (opt-in), matching notify_on_price_change which
--   is the closest analog (low-signal events most users won't want by default).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notify_on_comment_received BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN users.notify_on_comment_received IS
  'Send notification when one of the user''s owned ENS names receives a comment';

ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS notify_on_comment BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN watchlist.notify_on_comment IS
  'Send notification when this watched name receives a comment';
