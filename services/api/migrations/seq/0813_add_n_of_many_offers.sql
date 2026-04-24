-- Migration: Add n-of-many offers support
-- Created: 2026-04-09
--
-- N-of-many offers allow a buyer to create N criteria-based offers,
-- each valid for any of M candidate names. Exactly N can be fulfilled;
-- no cancellation needed since there are no extra orders.

-- N-of-many offer groups
CREATE TABLE n_of_many_groups (
    id SERIAL PRIMARY KEY,
    buyer_address VARCHAR(42) NOT NULL,
    target_count INTEGER NOT NULL,           -- N (how many to buy)
    total_items INTEGER NOT NULL,            -- M (size of candidate set)
    offer_amount_wei VARCHAR(78) NOT NULL,   -- price per item
    merkle_root VARCHAR(66) NOT NULL,
    token_ids TEXT[] NOT NULL,
    fulfilled_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    currency_address VARCHAR(42) DEFAULT '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tree_height INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    CONSTRAINT valid_n_of_many_status CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
    CONSTRAINT target_lte_total CHECK (target_count <= total_items),
    CONSTRAINT target_positive CHECK (target_count >= 1),
    CONSTRAINT total_positive CHECK (total_items >= 2)
);

-- Link offers to n_of_many groups
ALTER TABLE offers ADD COLUMN n_of_many_group_id INTEGER REFERENCES n_of_many_groups(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX idx_n_of_many_groups_buyer ON n_of_many_groups(buyer_address);
CREATE INDEX idx_n_of_many_groups_status ON n_of_many_groups(status);
CREATE INDEX idx_offers_n_of_many_group ON offers(n_of_many_group_id) WHERE n_of_many_group_id IS NOT NULL;

-- Configurable limits for n-of-many
INSERT INTO offer_limits (key, value, description) VALUES
  ('max_n_of_many_target_count', '50', 'Max target count (N) for n-of-many offers'),
  ('max_n_of_many_items', '1000', 'Max candidate items (M) for n-of-many offers');
