-- Force fix offers index - remove WHERE clause
-- Migration: force_fix_offers_index
-- Created: 2025-10-03

-- Drop the partial index
DROP INDEX IF EXISTS offers_order_hash_source_unique;

-- Recreate WITHOUT the WHERE clause (unconditional unique index needed for ON CONFLICT)
CREATE UNIQUE INDEX offers_order_hash_source_unique
ON offers(order_hash, source);

-- Verify
SELECT indexdef
FROM pg_indexes
WHERE tablename = 'offers'
AND indexname = 'offers_order_hash_source_unique';
