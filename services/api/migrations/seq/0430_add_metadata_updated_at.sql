-- Migration: Add metadata_updated_at column for TTL-based metadata refresh
--
-- Purpose: Track when ENS metadata was last fetched from The Graph
-- This enables on-demand refresh when metadata is stale (>72 hours)
--
-- Separate from updated_at because:
-- - updated_at tracks any row change (owner, expiry, etc.)
-- - metadata_updated_at specifically tracks when text records were fetched

BEGIN;

-- Add metadata_updated_at column
ALTER TABLE ens_names
  ADD COLUMN IF NOT EXISTS metadata_updated_at TIMESTAMPTZ;

-- Backfill: set to updated_at for existing rows with non-empty metadata
-- This prevents immediate refresh storms on existing data
UPDATE ens_names
SET metadata_updated_at = updated_at
WHERE metadata IS NOT NULL
  AND metadata != '{}'::jsonb
  AND metadata_updated_at IS NULL;

-- Add index for finding stale metadata (optional, for batch processing)
CREATE INDEX IF NOT EXISTS idx_ens_names_metadata_updated_at
  ON ens_names (metadata_updated_at)
  WHERE metadata_updated_at IS NOT NULL;

COMMIT;

-- Verification queries (run manually after migration):
--
-- Check column exists:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'ens_names' AND column_name = 'metadata_updated_at';
--
-- Check backfill worked:
-- SELECT COUNT(*) as total,
--        COUNT(metadata_updated_at) as with_timestamp,
--        COUNT(*) FILTER (WHERE metadata != '{}'::jsonb) as with_metadata
-- FROM ens_names;
