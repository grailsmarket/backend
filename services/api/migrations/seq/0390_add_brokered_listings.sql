-- Migration: Add brokered listings support
-- Adds broker_address and broker_fee_bps columns to listings table

-- Add broker columns to listings table
ALTER TABLE listings ADD COLUMN IF NOT EXISTS broker_address VARCHAR(42);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS broker_fee_bps INTEGER;

-- Add check constraint for broker fee basis points (0-10000)
ALTER TABLE listings ADD CONSTRAINT check_broker_fee_bps
  CHECK (broker_fee_bps IS NULL OR (broker_fee_bps >= 0 AND broker_fee_bps <= 10000));

-- Add check constraint: if broker_address is set, broker_fee_bps must also be set (and vice versa)
ALTER TABLE listings ADD CONSTRAINT check_broker_fields_consistency
  CHECK (
    (broker_address IS NULL AND broker_fee_bps IS NULL) OR
    (broker_address IS NOT NULL AND broker_fee_bps IS NOT NULL)
  );

-- Index for broker address lookups (find all listings by a specific broker)
CREATE INDEX IF NOT EXISTS idx_listings_broker_address ON listings (broker_address)
  WHERE broker_address IS NOT NULL;

-- Column comments
COMMENT ON COLUMN listings.broker_address IS 'Address of the broker who created this listing (receives broker fee on sale)';
COMMENT ON COLUMN listings.broker_fee_bps IS 'Broker fee in basis points (100 = 1%). Must be >= BROKER_MIN_FEE_BASIS_POINTS env var';
