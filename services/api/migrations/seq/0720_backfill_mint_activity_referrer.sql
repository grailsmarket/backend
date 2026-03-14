-- Migration: 0720_backfill_mint_activity_referrer
-- Description: Backfill mint activity_history metadata with referrer and registration_source
-- from the registrations table where referrer is available.

UPDATE activity_history ah
SET metadata = ah.metadata || jsonb_build_object(
  'referrer', r.referrer,
  'registration_source', CASE r.referrer
    WHEN '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d' THEN 'grails'
    WHEN '0x000000000000000000000000f919a96d2970380b87917b04f02e6d3d08368b10' THEN 'vision'
    ELSE NULL
  END
)
FROM registrations r
WHERE ah.ens_name_id = r.ens_name_id
  AND ah.transaction_hash = r.transaction_hash
  AND ah.event_type = 'mint'
  AND r.referrer IS NOT NULL
  AND (ah.metadata->>'referrer') IS NULL;
