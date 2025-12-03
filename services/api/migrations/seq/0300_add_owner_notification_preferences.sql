-- Migration: Add owner notification preferences to users table
-- These settings control automatic notifications for ENS name owners

-- Add notification preference columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS notify_on_offer_received BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS notify_on_listing_sold BOOLEAN DEFAULT TRUE;

-- Add comments
COMMENT ON COLUMN users.notify_on_offer_received IS 'Send notification when user receives an offer on their ENS name';
COMMENT ON COLUMN users.notify_on_listing_sold IS 'Send notification when user''s listing is sold';

-- Set defaults for existing users (opt-in by default)
UPDATE users
SET notify_on_offer_received = TRUE,
    notify_on_listing_sold = TRUE
WHERE notify_on_offer_received IS NULL
   OR notify_on_listing_sold IS NULL;
