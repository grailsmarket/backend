-- Migration: Add 'listing_cancelled' and 'offer_cancelled' enum values
-- Note: ADD VALUE cannot be used in the same transaction as statements that use the new values.
-- Data migration is in 0285_migrate_cancelled_events.sql.

ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'listing_cancelled';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'offer_cancelled';
