-- Migration: Add bulk offers support (shotgun + criteria/pick-one modes)
-- Created: 2026-03-10

-- Bulk offer groups (Mode 1: shotgun offers)
CREATE TABLE bulk_offer_groups (
    id SERIAL PRIMARY KEY,
    buyer_address VARCHAR(42) NOT NULL,
    offer_count INTEGER NOT NULL,
    tree_height INTEGER NOT NULL,
    merkle_root VARCHAR(66),
    total_amount_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42) DEFAULT '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    CONSTRAINT valid_bulk_status CHECK (status IN ('active', 'cancelled', 'partially_cancelled', 'expired'))
);

-- Link offers to their bulk group
ALTER TABLE offers ADD COLUMN bulk_offer_group_id INTEGER REFERENCES bulk_offer_groups(id) ON DELETE SET NULL;
ALTER TABLE offers ADD COLUMN bulk_order_index INTEGER;
ALTER TABLE offers ADD COLUMN offer_type VARCHAR(20) DEFAULT 'individual';

-- Criteria offers (Mode 2: pick-one)
CREATE TABLE criteria_offers (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    token_ids TEXT[] NOT NULL,
    merkle_root VARCHAR(66) NOT NULL,
    fulfilled_token_id VARCHAR(78),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Update offers status constraint to include 'cancelled'
ALTER TABLE offers DROP CONSTRAINT valid_status;
ALTER TABLE offers ADD CONSTRAINT valid_status
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'unfunded', 'cancelled'));

-- Configurable offer limits
CREATE TABLE offer_limits (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) NOT NULL UNIQUE,
    value VARCHAR(255) NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO offer_limits (key, value, description) VALUES
  ('max_bulk_offers_per_request', '500', 'Max offers in a single bulk request'),
  ('max_active_offers_per_user', '5000', 'Max concurrent pending offers per user'),
  ('min_offer_amount_wei', '100000000000000', 'Minimum offer amount (0.0001 ETH)'),
  ('min_offer_floor_pct', '10', 'Min offer as % of club floor price'),
  ('max_bulk_offer_names', '10000', 'Max names per bulk offer'),
  ('max_criteria_offer_names', '1000', 'Max names in a pick-one criteria offer'),
  ('bulk_offers_enabled', 'true', 'Global kill switch');

-- Indexes
CREATE INDEX idx_bulk_offer_groups_buyer ON bulk_offer_groups(buyer_address);
CREATE INDEX idx_bulk_offer_groups_status ON bulk_offer_groups(status);
CREATE INDEX idx_offers_bulk_group ON offers(bulk_offer_group_id) WHERE bulk_offer_group_id IS NOT NULL;
CREATE INDEX idx_offers_type ON offers(offer_type) WHERE offer_type != 'individual';
CREATE INDEX idx_criteria_offers_offer ON criteria_offers(offer_id);

-- updated_at trigger for offer_limits
CREATE TRIGGER update_offer_limits_updated_at
    BEFORE UPDATE ON offer_limits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
