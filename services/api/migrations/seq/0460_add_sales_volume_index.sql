-- Add index for optimizing sales volume aggregation queries
-- Migration: 0460_add_sales_volume_index
-- Created: 2025-02-17

-- This index optimizes the sales_volume calculation in the leaderboard query
-- by creating a composite index on (seller_address, sale_price_wei)
-- which allows efficient SUM aggregation grouped by seller

-- Create composite index for sales volume aggregation
-- This speeds up queries that calculate total sales volume per seller
CREATE INDEX IF NOT EXISTS idx_sales_seller_price
ON sales(LOWER(seller_address), sale_price_wei);

-- Add partial index for active sales (if we want to filter by status in the future)
-- This is useful if we ever need to filter sales by certain criteria
CREATE INDEX IF NOT EXISTS idx_sales_seller_price_with_currency
ON sales(LOWER(seller_address), sale_price_wei, currency_address)
WHERE currency_address = '0x0000000000000000000000000000000000000000';

-- Comment for documentation
COMMENT ON INDEX idx_sales_seller_price IS 'Optimizes sales volume aggregation queries for leaderboard by seller address';
COMMENT ON INDEX idx_sales_seller_price_with_currency IS 'Optimizes sales volume queries filtered by ETH (native currency) sales';
