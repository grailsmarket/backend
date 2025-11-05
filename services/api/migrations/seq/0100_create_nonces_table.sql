-- Create nonces table for SIWE authentication
-- Migration: create_nonces_table
-- Created: 2025-10-06

CREATE TABLE nonces (
  id SERIAL PRIMARY KEY,
  nonce VARCHAR(64) NOT NULL UNIQUE,     -- Random nonce string
  address VARCHAR(42) NOT NULL,          -- Address requesting nonce
  expires_at TIMESTAMP NOT NULL,         -- Expiration time (5 minutes from creation)
  used BOOLEAN DEFAULT FALSE,            -- Whether nonce has been used
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_nonces_nonce ON nonces(nonce) WHERE used = FALSE;
CREATE INDEX idx_nonces_address ON nonces(address);
CREATE INDEX idx_nonces_expires_at ON nonces(expires_at) WHERE used = FALSE;

-- Comments
COMMENT ON TABLE nonces IS 'Stores one-time nonces for SIWE authentication';
COMMENT ON COLUMN nonces.nonce IS 'Random nonce string (min 8 alphanumeric characters)';
COMMENT ON COLUMN nonces.expires_at IS 'Nonce expiration (5 minutes)';
COMMENT ON COLUMN nonces.used IS 'Prevents nonce reuse';

-- Auto-cleanup trigger (delete expired nonces after new inserts)
CREATE OR REPLACE FUNCTION cleanup_expired_nonces()
RETURNS trigger AS $$
BEGIN
  DELETE FROM nonces WHERE expires_at < NOW() - INTERVAL '1 hour';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_nonces
  AFTER INSERT ON nonces
  EXECUTE FUNCTION cleanup_expired_nonces();
