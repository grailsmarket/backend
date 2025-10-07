-- Add transfer event types to activity_event_type enum
-- Migration: add_transfer_event_types
-- Created: 2025-10-03

-- Add new event types to the enum
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'mint';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'burn';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'sent';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'received';

-- Update comments for documentation
COMMENT ON TYPE activity_event_type IS 'Activity event types: listed, listing_updated, offer_made, bought, sold, offer_accepted, cancelled, mint, burn, sent, received';
