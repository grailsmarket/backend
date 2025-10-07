-- Create activity_history table for tracking marketplace events
-- Migration: create_activity_history
-- Created: 2025-10-02

-- Create enum for activity event types
CREATE TYPE activity_event_type AS ENUM (
  'listed',
  'listing_updated',
  'offer_made',
  'bought',
  'sold',
  'offer_accepted',
  'cancelled'
);

-- Create activity_history table
CREATE TABLE IF NOT EXISTS activity_history (
  id SERIAL PRIMARY KEY,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  event_type activity_event_type NOT NULL,
  actor_address VARCHAR(42) NOT NULL,
  counterparty_address VARCHAR(42),
  platform VARCHAR(50) NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 1,
  price_wei VARCHAR(78),
  currency_address VARCHAR(42),
  transaction_hash VARCHAR(66),
  block_number BIGINT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX idx_activity_history_ens_name_id ON activity_history(ens_name_id);
CREATE INDEX idx_activity_history_actor_address ON activity_history(actor_address);
CREATE INDEX idx_activity_history_counterparty_address ON activity_history(counterparty_address) WHERE counterparty_address IS NOT NULL;
CREATE INDEX idx_activity_history_event_type ON activity_history(event_type);
CREATE INDEX idx_activity_history_platform ON activity_history(platform);
CREATE INDEX idx_activity_history_chain_id ON activity_history(chain_id);
CREATE INDEX idx_activity_history_created_at ON activity_history(created_at DESC);
CREATE INDEX idx_activity_history_transaction_hash ON activity_history(transaction_hash) WHERE transaction_hash IS NOT NULL;

-- Composite indexes for common query patterns
CREATE INDEX idx_activity_history_name_created ON activity_history(ens_name_id, created_at DESC);
CREATE INDEX idx_activity_history_actor_created ON activity_history(actor_address, created_at DESC);
CREATE INDEX idx_activity_history_name_event_created ON activity_history(ens_name_id, event_type, created_at DESC);

-- Add comments for documentation
COMMENT ON TABLE activity_history IS 'Tracks all marketplace activity for ENS names including listings, offers, sales, and cancellations';
COMMENT ON COLUMN activity_history.actor_address IS 'Address of the user who initiated the action (buyer, seller, offerer)';
COMMENT ON COLUMN activity_history.counterparty_address IS 'Address of the counterparty (seller in a buy, buyer in a sell, null for listings/offers)';
COMMENT ON COLUMN activity_history.platform IS 'Platform where the event occurred (grails, opensea, both)';
COMMENT ON COLUMN activity_history.chain_id IS 'Blockchain chain ID (1 for Ethereum mainnet, 11155111 for Sepolia, etc.)';
COMMENT ON COLUMN activity_history.metadata IS 'Additional event-specific data stored as JSON';
