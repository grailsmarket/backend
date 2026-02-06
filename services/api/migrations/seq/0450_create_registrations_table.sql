-- Migration: 0450_create_registrations_table
-- Description: Create registrations table to track ENS name registration costs (base cost + premium)
-- This data comes from the ENS ETH Registrar Controller contract NameRegistered events

CREATE TABLE registrations (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,

    -- Addresses
    registrant_address VARCHAR(42) NOT NULL,  -- Transaction sender (who paid)
    owner_address VARCHAR(42) NOT NULL,       -- Recipient (may differ, e.g. gifted registrations)

    -- Cost breakdown (in wei, stored as string for precision)
    base_cost_wei VARCHAR(78) NOT NULL,
    premium_wei VARCHAR(78) NOT NULL DEFAULT '0',
    total_cost_wei VARCHAR(78) NOT NULL,

    -- Name details (for analytics)
    name_length INTEGER NOT NULL,

    -- Blockchain details
    transaction_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    registration_date TIMESTAMPTZ NOT NULL,
    expiry_date TIMESTAMPTZ NOT NULL,

    -- Metadata (for extensibility)
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Ensure we don't duplicate registrations for the same tx/name combo
    CONSTRAINT unique_registration_tx UNIQUE (transaction_hash, ens_name_id)
);

-- Index for looking up registrations by ENS name
CREATE INDEX idx_registrations_ens_name_id ON registrations(ens_name_id);

-- Index for looking up registrations by registrant address
CREATE INDEX idx_registrations_registrant ON registrations(registrant_address);

-- Index for time-based queries (analytics)
CREATE INDEX idx_registrations_date ON registrations(registration_date DESC);

-- Index for analytics by name length
CREATE INDEX idx_registrations_name_length ON registrations(name_length);

-- Composite index for time + length analytics
CREATE INDEX idx_registrations_date_length ON registrations(registration_date DESC, name_length);

-- Add comment for documentation
COMMENT ON TABLE registrations IS 'Tracks ENS name registration costs from Controller contract events';
COMMENT ON COLUMN registrations.base_cost_wei IS 'Base registration cost in wei (excludes premium)';
COMMENT ON COLUMN registrations.premium_wei IS 'Premium paid during Dutch auction period in wei';
COMMENT ON COLUMN registrations.total_cost_wei IS 'Total cost in wei (base_cost + premium)';
COMMENT ON COLUMN registrations.name_length IS 'Character count of name label (excluding .eth)';
