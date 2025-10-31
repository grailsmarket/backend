-- Migration: Add club analytics columns
-- Description: Adds floor price, sales count, and sales volume tracking to clubs table
-- Date: 2025-10-30

-- ============================================================================
-- Add analytics columns to clubs table
-- ============================================================================

-- Floor price tracking
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS floor_price_wei VARCHAR(78);
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS floor_price_currency VARCHAR(42) DEFAULT '0x0000000000000000000000000000000000000000';

-- Sales statistics
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_sales_count INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_sales_volume_wei VARCHAR(78) DEFAULT '0';

-- Last update timestamps
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS last_floor_update TIMESTAMP;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS last_sales_update TIMESTAMP;

-- ============================================================================
-- Create indexes for performance
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_clubs_floor_price
ON clubs(floor_price_wei)
WHERE floor_price_wei IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clubs_sales_volume
ON clubs(total_sales_volume_wei);

CREATE INDEX IF NOT EXISTS idx_clubs_sales_count
ON clubs(total_sales_count);

-- ============================================================================
-- Add comments for documentation
-- ============================================================================

COMMENT ON COLUMN clubs.floor_price_wei IS 'Lowest active listing price for club members in wei (ETH only)';
COMMENT ON COLUMN clubs.floor_price_currency IS 'Currency address for floor price (0x0 for ETH)';
COMMENT ON COLUMN clubs.total_sales_count IS 'Total number of sales for all club members';
COMMENT ON COLUMN clubs.total_sales_volume_wei IS 'Total sales volume for all club members in wei (ETH only)';
COMMENT ON COLUMN clubs.last_floor_update IS 'Timestamp of last floor price update';
COMMENT ON COLUMN clubs.last_sales_update IS 'Timestamp of last sales statistics update';
