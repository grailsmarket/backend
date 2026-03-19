-- Backfill duration_seconds into activity_history metadata for mint and renewal events

-- Mint events: compute duration from registrations table (exact blockchain timestamps)
UPDATE activity_history ah
SET metadata = ah.metadata || jsonb_build_object(
  'duration_seconds', EXTRACT(EPOCH FROM (r.expiry_date - r.registration_date))::bigint
)
FROM registrations r
WHERE ah.event_type = 'mint'
  AND ah.transaction_hash = r.transaction_hash
  AND ah.ens_name_id = r.ens_name_id
  AND (ah.metadata->>'duration_seconds') IS NULL;

-- Renewal events (RenewalReferred only): use explicit duration_seconds from renewals table
UPDATE activity_history ah
SET metadata = ah.metadata || jsonb_build_object('duration_seconds', rn.duration_seconds)
FROM renewals rn
WHERE ah.event_type = 'renewal'
  AND ah.transaction_hash = rn.transaction_hash
  AND ah.ens_name_id = rn.ens_name_id
  AND rn.duration_seconds IS NOT NULL
  AND (ah.metadata->>'duration_seconds') IS NULL;
