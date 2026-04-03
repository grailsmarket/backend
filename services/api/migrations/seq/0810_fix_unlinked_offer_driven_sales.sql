-- Fix unlinked offer-driven sales and correct platform attribution.
--
-- Migration 0800 Step 2 updated 0 records because it required sales.offer_id IS NOT NULL,
-- but offer-driven sales (e.g., cap.eth) had offer_id = NULL. This happened when the
-- Seaport indexer created the sale first (matching offers by order_hash only, which failed),
-- and the OpenSea stream later skipped creation because the sale already existed.
--
-- This migration links orphaned sales to their accepted offers by matching on
-- ens_name_id + buyer_address + time proximity, then fixes the platform on activity records.

-- Step 1: Link unlinked sales to their corresponding accepted offers and fix sales.source.
WITH matched AS (
  SELECT DISTINCT ON (s.id)
    s.id AS sale_id,
    o.id AS offer_id,
    o.source AS offer_source
  FROM sales s
  JOIN offers o
    ON o.ens_name_id = s.ens_name_id
    AND o.buyer_address = s.buyer_address
    AND o.status = 'accepted'
    AND o.created_at <= s.sale_date
    AND o.created_at >= s.sale_date - INTERVAL '7 days'
  WHERE s.offer_id IS NULL
  ORDER BY s.id, o.created_at DESC
)
UPDATE sales s
SET offer_id = m.offer_id,
    source = m.offer_source
FROM matched m
WHERE s.id = m.sale_id;

-- Step 2: Fix platform on activity records for the now-linked sales.
UPDATE activity_history ah
SET platform = s.source
FROM sales s
WHERE ah.event_type IN ('bought', 'sold')
  AND ah.metadata->>'sale_id' IS NOT NULL
  AND s.id = (ah.metadata->>'sale_id')::integer
  AND s.offer_id IS NOT NULL
  AND s.source != ah.platform;

-- Step 3: Add index to support fallback offer lookup in Seaport indexer.
CREATE INDEX IF NOT EXISTS idx_offers_ens_name_buyer_status
  ON offers(ens_name_id, buyer_address, status);
