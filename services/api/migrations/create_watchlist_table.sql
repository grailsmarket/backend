-- Create watchlist table for ENS name tracking
-- Migration: create_watchlist_table
-- Created: 2025-10-06

CREATE TABLE watchlist (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  notify_on_sale BOOLEAN DEFAULT TRUE,           -- Notify on sales
  notify_on_offer BOOLEAN DEFAULT TRUE,          -- Notify on new offers
  notify_on_listing BOOLEAN DEFAULT TRUE,        -- Notify on new listings
  notify_on_price_change BOOLEAN DEFAULT FALSE,  -- Notify on price changes
  added_at TIMESTAMP DEFAULT NOW(),

  -- Prevent duplicate entries
  UNIQUE(user_id, ens_name_id)
);

-- Indexes
CREATE INDEX idx_watchlist_user_id ON watchlist(user_id);
CREATE INDEX idx_watchlist_ens_name_id ON watchlist(ens_name_id);
CREATE INDEX idx_watchlist_added_at ON watchlist(added_at DESC);

-- Composite index for common query pattern
CREATE INDEX idx_watchlist_user_name ON watchlist(user_id, ens_name_id);

-- Comments
COMMENT ON TABLE watchlist IS 'Stores user watchlists for ENS name notifications';
COMMENT ON COLUMN watchlist.notify_on_sale IS 'Send notification when name is sold';
COMMENT ON COLUMN watchlist.notify_on_offer IS 'Send notification on new offers';
COMMENT ON COLUMN watchlist.notify_on_listing IS 'Send notification on new listings';
COMMENT ON COLUMN watchlist.notify_on_price_change IS 'Send notification on price changes';
