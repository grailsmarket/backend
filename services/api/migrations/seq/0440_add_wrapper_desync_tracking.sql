-- Migration: Add wrapper desync tracking columns
--
-- Purpose: Track when a wrapped ENS name has out-of-sync expiry dates between
-- the BaseRegistrar and NameWrapper contracts.
--
-- Background:
-- When a wrapped name is renewed through the old ETHRegistrarController instead
-- of the NameWrapper-aware controller, the expiry gets updated in the BaseRegistrar
-- but NOT in the NameWrapper. This causes:
--   - Purchases to fail (wrapper thinks name is expired)
--   - Names show as "misconfigured" in ENS app
--
-- Detection logic:
--   If wrapperExpiry != registrarExpiry + 90 days grace period → NAME IS DESYNCED
--
-- Reference: https://github.com/ensdomains/ens-app-v3/pull/1107

BEGIN;

-- Add is_desynced column to track wrapper desync status
ALTER TABLE ens_names
  ADD COLUMN IF NOT EXISTS is_desynced BOOLEAN DEFAULT FALSE;

-- Add desync_checked_at to track when desync status was last verified on-chain
ALTER TABLE ens_names
  ADD COLUMN IF NOT EXISTS desync_checked_at TIMESTAMPTZ;

-- Index for finding desynced names (for API filtering)
-- Partial index only includes desynced names for efficiency
CREATE INDEX IF NOT EXISTS idx_ens_names_is_desynced
  ON ens_names(is_desynced)
  WHERE is_desynced = TRUE;

-- Index for worker scheduling (find oldest-checked names)
-- NULL values sort first so unchecked names get priority
CREATE INDEX IF NOT EXISTS idx_ens_names_desync_checked_at
  ON ens_names(desync_checked_at NULLS FIRST);

-- Add comments for documentation
COMMENT ON COLUMN ens_names.is_desynced IS
  'True if wrapper expiry < registrar expiry + 90 days grace period (purchases may fail)';

COMMENT ON COLUMN ens_names.desync_checked_at IS
  'Last time desync status was verified on-chain via the validate-wrapper-sync worker';

COMMIT;

-- Verification queries (run manually after migration):
--
-- Check columns exist:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'ens_names'
--   AND column_name IN ('is_desynced', 'desync_checked_at');
--
-- Check indexes:
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'ens_names'
--   AND indexname LIKE '%desync%';
