-- Migration: 0730_backfill_mint_activity_platform
-- Description: Backfill mint activity_history platform column with registration_source
-- from metadata, so the existing platform filter works for referred mints.

UPDATE activity_history
SET platform = metadata->>'registration_source'
WHERE event_type = 'mint'
  AND metadata->>'registration_source' IS NOT NULL
  AND platform = 'blockchain';
