-- Clean up duplicate sale activity records and fix platform attribution.
--
-- Bug: Two independent code paths both created 'bought'/'sold' activity records:
--   1. Database trigger (create_activity_on_sale) on sales INSERT — has transaction_hash
--   2. WAL listener (handleOfferAccepted -> createSaleRecords) — no transaction_hash
-- The WAL listener path has been removed in the code fix; this migration cleans up
-- existing duplicates and corrects platform attribution for offer-driven sales.

-- Step 1: Delete duplicate activity records (those without tx_hash where a proper one exists)
DELETE FROM activity_history dup
WHERE dup.event_type IN ('bought', 'sold')
  AND dup.transaction_hash IS NULL
  AND EXISTS (
    SELECT 1 FROM activity_history orig
    WHERE orig.ens_name_id = dup.ens_name_id
      AND orig.event_type = dup.event_type
      AND orig.actor_address = dup.actor_address
      AND orig.transaction_hash IS NOT NULL
      AND (
        -- Match on offer_id if both have it
        (dup.metadata->>'offer_id' IS NOT NULL
         AND orig.metadata->>'offer_id' = dup.metadata->>'offer_id')
        OR
        -- Match on listing_id if both have it
        (dup.metadata->>'listing_id' IS NOT NULL
         AND orig.metadata->>'listing_id' = dup.metadata->>'listing_id')
        OR
        -- Match on sale_id + counterparty within time window
        (orig.metadata->>'sale_id' IS NOT NULL
         AND orig.counterparty_address = dup.counterparty_address
         AND orig.created_at BETWEEN dup.created_at - INTERVAL '10 minutes'
                                 AND dup.created_at + INTERVAL '10 minutes')
      )
  );

-- Step 2: Fix platform on remaining records where the sale was offer-driven.
-- The offer source is the authoritative platform for offer acceptance sales.
UPDATE activity_history ah
SET platform = o.source
FROM sales s
JOIN offers o ON o.id = s.offer_id
WHERE ah.event_type IN ('bought', 'sold')
  AND ah.metadata->>'sale_id' IS NOT NULL
  AND s.id = (ah.metadata->>'sale_id')::integer
  AND s.offer_id IS NOT NULL
  AND o.source IS NOT NULL
  AND o.source != ah.platform;
