-- Migration: Split 'cancelled' event type into 'listing_cancelled' and 'offer_cancelled'
-- This provides better granularity for activity history events

-- Step 1: Add new event types to the enum
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'listing_cancelled';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'offer_cancelled';

-- Step 2: Update existing 'cancelled' events based on metadata
-- Events with listing_id in metadata become 'listing_cancelled'
UPDATE activity_history
SET event_type = 'listing_cancelled'
WHERE event_type = 'cancelled'
  AND metadata->>'cancelled_type' = 'listing';

-- Events with offer_id in metadata become 'offer_cancelled'
UPDATE activity_history
SET event_type = 'offer_cancelled'
WHERE event_type = 'cancelled'
  AND metadata->>'cancelled_type' = 'offer';

-- Step 3: Check for any remaining 'cancelled' events that don't have metadata
-- These should be rare, but we'll default them to listing_cancelled
-- (historically, most cancellations were listings before offers were tracked)
UPDATE activity_history
SET event_type = 'listing_cancelled'
WHERE event_type = 'cancelled'
  AND (metadata->>'cancelled_type' IS NULL OR metadata->>'cancelled_type' = '');

-- Step 4: Verify the migration
DO $$
DECLARE
  remaining_cancelled_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_cancelled_count
  FROM activity_history
  WHERE event_type = 'cancelled';

  IF remaining_cancelled_count > 0 THEN
    RAISE WARNING 'Still have % cancelled events remaining after migration', remaining_cancelled_count;
  ELSE
    RAISE NOTICE 'Successfully migrated all cancelled events to listing_cancelled/offer_cancelled';
  END IF;
END $$;

-- Step 5: Update the comment on the enum type
COMMENT ON TYPE activity_event_type IS 'Activity event types: listed, listing_updated, offer_made, bought, sold, offer_accepted, listing_cancelled, offer_cancelled, mint, burn, sent, received, cancelled (deprecated)';
