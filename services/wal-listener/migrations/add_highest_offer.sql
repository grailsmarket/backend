-- Migration: Add highest offer tracking to ens_names
-- Description: Adds columns to track the highest active offer for each ENS name
-- Date: 2025-10-31

-- Add highest offer columns to ens_names table
ALTER TABLE ens_names ADD COLUMN IF NOT EXISTS highest_offer_wei VARCHAR(78);
ALTER TABLE ens_names ADD COLUMN IF NOT EXISTS highest_offer_currency VARCHAR(42) DEFAULT '0x0000000000000000000000000000000000000000';
ALTER TABLE ens_names ADD COLUMN IF NOT EXISTS highest_offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL;
ALTER TABLE ens_names ADD COLUMN IF NOT EXISTS last_offer_update TIMESTAMP;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ens_names_highest_offer_wei
ON ens_names(highest_offer_wei)
WHERE highest_offer_wei IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ens_names_highest_offer_id
ON ens_names(highest_offer_id)
WHERE highest_offer_id IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN ens_names.highest_offer_wei IS 'Highest active offer amount in wei (ETH only)';
COMMENT ON COLUMN ens_names.highest_offer_currency IS 'Currency address for highest offer (0x0 for ETH)';
COMMENT ON COLUMN ens_names.highest_offer_id IS 'Foreign key to the offer with the highest amount';
COMMENT ON COLUMN ens_names.last_offer_update IS 'Timestamp of last highest offer update';
