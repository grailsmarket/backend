-- Fix NULL source values in offers table
-- Migration: fix_offers_source_nulls
-- Created: 2025-10-03

-- Temporarily disable the WAL trigger to avoid triggering 22k events (if it exists)
-- Note: The trigger is created by the WAL listener service, not in migrations
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notify_offers_changes') THEN
    ALTER TABLE offers DISABLE TRIGGER notify_offers_changes;
  END IF;
END $$;

-- Update all NULL source values to 'opensea' (since these are likely from OpenSea stream)
UPDATE offers
SET source = 'opensea'
WHERE source IS NULL;

-- Re-enable the trigger (if it was disabled)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notify_offers_changes') THEN
    ALTER TABLE offers ENABLE TRIGGER notify_offers_changes;
  END IF;
END $$;

-- Make source NOT NULL going forward
ALTER TABLE offers ALTER COLUMN source SET NOT NULL;
ALTER TABLE offers ALTER COLUMN source SET DEFAULT 'grails';

-- Verify the fix
DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count FROM offers WHERE source IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'Still have % NULL source values', null_count;
  ELSE
    RAISE NOTICE 'All source values updated successfully. Zero NULL values remain.';
  END IF;
END $$;
