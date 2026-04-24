-- Migration: Migrate 'cancelled' events to 'listing_cancelled' / 'offer_cancelled'
-- Depends on 0280 which added the new enum values.

-- Events with listing cancelled_type become 'listing_cancelled'
UPDATE activity_history
SET event_type = 'listing_cancelled'
WHERE event_type = 'cancelled'
  AND metadata->>'cancelled_type' = 'listing';

-- Events with offer cancelled_type become 'offer_cancelled'
UPDATE activity_history
SET event_type = 'offer_cancelled'
WHERE event_type = 'cancelled'
  AND metadata->>'cancelled_type' = 'offer';

-- Default remaining 'cancelled' events to listing_cancelled
-- (historically, most cancellations were listings before offers were tracked)
UPDATE activity_history
SET event_type = 'listing_cancelled'
WHERE event_type = 'cancelled'
  AND (metadata->>'cancelled_type' IS NULL OR metadata->>'cancelled_type' = '');

-- Verify the migration
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

-- Update the comment on the enum type
COMMENT ON TYPE activity_event_type IS 'Activity event types: listed, listing_updated, offer_made, bought, sold, offer_accepted, listing_cancelled, offer_cancelled, mint, burn, sent, received, cancelled (deprecated)';
