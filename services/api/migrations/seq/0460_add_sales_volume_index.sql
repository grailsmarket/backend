-- Add database index to optimize sales_volume queries
-- Migration: add_sales_volume_index
-- Created: 2025-02-16
-- Purpose: Optimize leaderboard queries that aggregate sales volume by seller address

-- Add composite index on sales table (seller_address, sale_price_wei)
-- This index will optimize the SUM aggregation for sales_volume calculation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_seller_price
ON sales(LOWER(seller_address), sale_price_wei);

-- Add comment for documentation
COMMENT ON INDEX idx_sales_seller_price IS 'Optimizes sales volume aggregation queries for leaderboard by indexing seller address and sale price';
