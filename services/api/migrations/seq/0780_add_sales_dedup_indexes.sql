-- Add indexes to support multi-criteria deduplication checks in createSale()
-- These prevent duplicate sales when the same trade is detected by both
-- the OpenSea Stream (real-time) and Seaport Indexer (blockchain scanning)

-- Index on order_hash for fast lookup by Seaport order identifier
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_order_hash
  ON sales(order_hash)
  WHERE order_hash IS NOT NULL;

-- Composite index for fuzzy dedup: same parties + same name within a time window
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_dedup_fuzzy
  ON sales(ens_name_id, seller_address, buyer_address, sale_date);
