-- Create legends table for tracking notable ENS minting activities
-- First use case: "prepunks" - names minted before CryptoPunks launched

CREATE TABLE legends (
  id SERIAL PRIMARY KEY,
  legend_type VARCHAR(50) NOT NULL,        -- 'prepunk', future types
  minter_address VARCHAR(42) NOT NULL,     -- ethereum address (lowercase)
  name VARCHAR(255) NOT NULL,              -- ENS name (e.g., 'rilxxlir')
  labelhash VARCHAR(66),                   -- labelhash hex
  namehash VARCHAR(66),                    -- namehash hex
  tx_hash VARCHAR(66) NOT NULL,            -- transaction hash
  block_number INTEGER NOT NULL,
  block_time TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(legend_type, tx_hash, name)       -- prevent duplicates
);

-- Index for address lookups (primary use case)
CREATE INDEX idx_legends_minter ON legends(minter_address);

-- Index for filtering by legend type
CREATE INDEX idx_legends_type ON legends(legend_type);

-- Composite index for type + address queries
CREATE INDEX idx_legends_type_minter ON legends(legend_type, minter_address);
