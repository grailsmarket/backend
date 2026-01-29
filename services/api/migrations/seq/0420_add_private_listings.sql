-- Migration: Add private listings support
-- Adds private_buyer_address column to listings table
-- When set, only the specified address can fulfill/purchase the listing

-- Add private buyer column to listings table
ALTER TABLE listings ADD COLUMN IF NOT EXISTS private_buyer_address VARCHAR(42);

-- Index for private buyer address lookups
-- Partial index only includes rows where private_buyer_address is set
CREATE INDEX IF NOT EXISTS idx_listings_private_buyer ON listings (private_buyer_address)
  WHERE private_buyer_address IS NOT NULL;

-- Column comments
COMMENT ON COLUMN listings.private_buyer_address IS 'Address of the only buyer allowed to purchase this listing. NULL = public listing';
