-- Migration: 0710_create_renewals_table
-- Description: Create renewals table to track ENS name renewal costs and referrer data
-- Data comes from Controller NameRenewed events and RenewalReferred events from the Event Emitter

CREATE TABLE renewals (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
    renewer_address VARCHAR(42) NOT NULL,
    cost_wei VARCHAR(78) NOT NULL,
    duration_seconds BIGINT,
    new_expiry_date TIMESTAMPTZ NOT NULL,
    referrer VARCHAR(66),
    name_length INTEGER NOT NULL,
    transaction_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    renewal_date TIMESTAMPTZ NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_renewal_tx UNIQUE (transaction_hash, ens_name_id)
);

CREATE INDEX idx_renewals_ens_name_id ON renewals(ens_name_id);
CREATE INDEX idx_renewals_renewer ON renewals(renewer_address);
CREATE INDEX idx_renewals_date ON renewals(renewal_date DESC);
CREATE INDEX idx_renewals_referrer ON renewals(referrer);
CREATE INDEX idx_renewals_name_length ON renewals(name_length);

COMMENT ON TABLE renewals IS 'Tracks ENS name renewal costs from Controller and Event Emitter contract events';
COMMENT ON COLUMN renewals.cost_wei IS 'Renewal cost in wei';
COMMENT ON COLUMN renewals.duration_seconds IS 'Renewal duration in seconds (only from RenewalReferred events)';
COMMENT ON COLUMN renewals.referrer IS 'bytes32 referrer code (from V2 Controller or RenewalReferred events)';
COMMENT ON COLUMN renewals.name_length IS 'Character count of name label (excluding .eth)';
