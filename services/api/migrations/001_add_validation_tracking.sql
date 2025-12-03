-- Migration: 001_add_validation_tracking.sql
-- Add validation tracking columns and tables for listing/offer validation system

BEGIN;

-- ============================================================================
-- Listings table updates
-- ============================================================================
-- Listings already has 'status' column with values: 'active', 'cancelled', 'sold', 'expired'
-- Adding new status value: 'unfunded'

-- Add new columns for validation tracking
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_reason TEXT;

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_listings_status_validated
  ON listings(status, last_validated_at)
  WHERE status IN ('active', 'unfunded');

-- Add comments
COMMENT ON COLUMN listings.last_validated_at IS 'Last time ownership was validated';
COMMENT ON COLUMN listings.unfunded_at IS 'When listing became unfunded';
COMMENT ON COLUMN listings.unfunded_reason IS 'Why listing is unfunded: ownership_lost, ownership_lost_onchain';

-- ============================================================================
-- Offers table updates
-- ============================================================================
-- Offers already has 'status' column with values: 'pending', 'accepted', 'cancelled', 'expired'
-- Adding new status value: 'unfunded'

-- Add new columns for validation tracking
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_reason TEXT;

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_offers_status_validated
  ON offers(status, last_validated_at)
  WHERE status IN ('pending', 'unfunded');

-- Add comments
COMMENT ON COLUMN offers.last_validated_at IS 'Last time balance was validated';
COMMENT ON COLUMN offers.unfunded_at IS 'When offer became unfunded';
COMMENT ON COLUMN offers.unfunded_reason IS 'Why offer is unfunded: insufficient_eth, insufficient_weth, insufficient_usdc, unsupported_currency';

-- ============================================================================
-- Notifications table updates
-- ============================================================================
-- Notifications already has 'type' column with values: 'new-listing', 'new-offer'
-- Adding new notification types for validation events:
--   - 'listing_unfunded'
--   - 'offer_unfunded'
--   - 'listing_refunded'
--   - 'offer_refunded'
-- No schema changes needed, just documenting the new type values

-- Index already exists from previous migration:
-- idx_notifications_unread ON notifications(user_id, read_at) WHERE read_at IS NULL

-- ============================================================================
-- Validation state table (NEW)
-- ============================================================================
-- Track validation schedule and history for listings and offers

CREATE TABLE IF NOT EXISTS validation_state (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL, -- 'listing' or 'offer'
  entity_id INTEGER NOT NULL,
  last_check_at TIMESTAMP NOT NULL DEFAULT NOW(),
  next_check_at TIMESTAMP NOT NULL, -- When to check next
  check_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id)
);

-- Add indexes
-- Note: Cannot use NOW() in index predicate, so we create unconditional index
CREATE INDEX idx_validation_state_next_check
  ON validation_state(next_check_at);

CREATE INDEX idx_validation_state_entity
  ON validation_state(entity_type, entity_id);

-- Add comments
COMMENT ON TABLE validation_state IS 'Tracks validation schedule and history for listings and offers';
COMMENT ON COLUMN validation_state.entity_type IS 'Type of entity: listing or offer';
COMMENT ON COLUMN validation_state.entity_id IS 'ID of the listing or offer';
COMMENT ON COLUMN validation_state.next_check_at IS 'When this entity should be validated next';
COMMENT ON COLUMN validation_state.consecutive_failures IS 'Count of consecutive validation failures';
COMMENT ON COLUMN validation_state.last_error IS 'Last validation error message';

COMMIT;
