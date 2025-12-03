-- Create mutelist table for filtering activity feed
-- Addresses on this list will be filtered from WebSocket activity broadcasts

CREATE TABLE IF NOT EXISTS mutelist (
  id SERIAL PRIMARY KEY,
  address VARCHAR(42) NOT NULL UNIQUE,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(42)
);

-- Index for fast lookups
CREATE INDEX idx_mutelist_address ON mutelist(address);

-- Add some comments
COMMENT ON TABLE mutelist IS 'Addresses to filter from WebSocket activity broadcasts';
COMMENT ON COLUMN mutelist.address IS 'Ethereum address to mute (normalized to lowercase)';
COMMENT ON COLUMN mutelist.reason IS 'Optional reason for muting this address';
COMMENT ON COLUMN mutelist.created_by IS 'Admin address who added this entry';
