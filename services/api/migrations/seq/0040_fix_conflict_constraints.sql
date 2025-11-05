-- Fix conflict constraints for listings and ens_names
-- Migration: fix_conflict_constraints
-- Created: 2025-10-02

-- 1. Add 'source' column to offers if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'offers' AND column_name = 'source'
  ) THEN
    ALTER TABLE offers ADD COLUMN source VARCHAR(50) DEFAULT 'opensea';
    RAISE NOTICE 'Added source column to offers table';
  END IF;
END $$;

-- 2. Drop old unique constraints on order_hash if they exist
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_order_hash_key;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_order_hash_key;

-- 3. Drop the partial constraints/indexes if they exist
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_order_hash_source_unique;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_order_hash_source_unique;

-- 4. Add composite unique constraints WITHOUT WHERE clause (needed for ON CONFLICT)
-- For listings: (order_hash, source) allows same order_hash on different platforms
CREATE UNIQUE INDEX IF NOT EXISTS listings_order_hash_source_unique
ON listings(order_hash, source);

-- For offers: (order_hash, source) allows same order_hash on different platforms
CREATE UNIQUE INDEX IF NOT EXISTS offers_order_hash_source_unique
ON offers(order_hash, source);

-- 2. Fix ens_names name uniqueness issue
-- Problem: OpenSea can send same name with different token_ids, causing insert failures
-- Solution: Drop strict unique constraint on name, rely on token_id as primary identifier

-- Drop the existing unique constraint on name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ens_names_name_key'
  ) THEN
    ALTER TABLE ens_names DROP CONSTRAINT ens_names_name_key;
    RAISE NOTICE 'Dropped unique constraint on ens_names.name';
  END IF;
END $$;

-- Create a partial unique index for real ENS names only
-- This still prevents duplicate real names while allowing placeholder duplicates
CREATE UNIQUE INDEX IF NOT EXISTS ens_names_real_name_unique
ON ens_names(name)
WHERE name NOT LIKE 'token-%' AND name ~ '^[a-z0-9-]+\.eth$';

COMMENT ON INDEX ens_names_real_name_unique IS
  'Ensures uniqueness of real ENS names (*.eth format) while allowing placeholders and bad OpenSea data. ENS indexer will clean up duplicates.';
