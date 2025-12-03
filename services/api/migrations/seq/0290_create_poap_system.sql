-- Migration: Create POAP (Proof of Active Participation) system
-- Allows users to claim unique POAP mint links

-- Create poap_links table to store claimable links
CREATE TABLE IF NOT EXISTS poap_links (
  id SERIAL PRIMARY KEY,
  link TEXT NOT NULL UNIQUE,
  claimed BOOLEAN NOT NULL DEFAULT FALSE,
  claimant_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create index on claimed status for fast unclaimed link lookup
CREATE INDEX idx_poap_links_claimed ON poap_links(claimed) WHERE claimed = FALSE;

-- Create index on claimant_id for user lookup
CREATE INDEX idx_poap_links_claimant_id ON poap_links(claimant_id);

-- Create trigger to update updated_at timestamp
CREATE TRIGGER update_poap_links_updated_at
  BEFORE UPDATE ON poap_links
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add comment to table
COMMENT ON TABLE poap_links IS 'Stores POAP mint links that can be claimed once per user';
COMMENT ON COLUMN poap_links.link IS 'Unique POAP mint link URL';
COMMENT ON COLUMN poap_links.claimed IS 'Whether this link has been claimed';
COMMENT ON COLUMN poap_links.claimant_id IS 'User ID of who claimed this link';
COMMENT ON COLUMN poap_links.claimed_at IS 'Timestamp when the link was claimed';
