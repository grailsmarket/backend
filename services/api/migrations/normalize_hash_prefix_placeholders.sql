-- Migration: Normalize Hash-Prefix Placeholder Names
-- Purpose: Convert nonstandard "#12345..." placeholder names to standard "token-12345" format
-- Issue: OpenSea events were storing "#tokenId" directly instead of normalizing to "token-tokenId"
-- Date: 2025-10-26

BEGIN;

-- Log the number of records to be updated
DO $$
DECLARE
  record_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO record_count
  FROM ens_names
  WHERE name LIKE '#%';

  RAISE NOTICE 'Found % records with #-prefix placeholder names to normalize', record_count;
END $$;

-- Update all #-prefix placeholder names to standard token- format
-- Only update names that start with # (nonstandard placeholders)
UPDATE ens_names
SET
  name = 'token-' || token_id,
  updated_at = NOW()
WHERE name LIKE '#%';

-- Log the result
DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Successfully normalized % placeholder names from # prefix to token- prefix', updated_count;
END $$;

COMMIT;

-- Verification query (run manually after migration)
-- SELECT COUNT(*) as remaining_hash_placeholders FROM ens_names WHERE name LIKE '#%';
-- Expected: 0
