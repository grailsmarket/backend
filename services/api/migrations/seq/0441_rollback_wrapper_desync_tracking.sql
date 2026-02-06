-- Rollback: Remove wrapper desync tracking columns
-- This undoes migration 0440 which was only run on dev

BEGIN;

-- Drop indexes first
DROP INDEX IF EXISTS idx_ens_names_is_desynced;
DROP INDEX IF EXISTS idx_ens_names_desync_checked_at;

-- Remove columns
ALTER TABLE ens_names DROP COLUMN IF EXISTS is_desynced;
ALTER TABLE ens_names DROP COLUMN IF EXISTS desync_checked_at;

COMMIT;
