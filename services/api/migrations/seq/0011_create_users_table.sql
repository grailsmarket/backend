-- Create users table for SIWE authentication
-- Migration: create_users_table
-- Created: 2025-10-06

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  address VARCHAR(42) NOT NULL UNIQUE,  -- Ethereum address (lowercase)
  email VARCHAR(255),                    -- For email notifications
  telegram VARCHAR(255),                 -- For Telegram notifications (future)
  discord VARCHAR(255),                  -- For Discord notifications (future)
  email_verified BOOLEAN DEFAULT FALSE,  -- Email verification status
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_sign_in TIMESTAMP
);

-- Indexes
CREATE INDEX idx_users_address ON users(LOWER(address));
CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_created_at ON users(created_at DESC);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE users IS 'Stores user accounts authenticated via SIWE';
COMMENT ON COLUMN users.address IS 'Ethereum address (stored lowercase for consistency)';
COMMENT ON COLUMN users.email IS 'Email address for notifications (optional)';
COMMENT ON COLUMN users.email_verified IS 'Whether email has been verified via confirmation link';
COMMENT ON COLUMN users.last_sign_in IS 'Timestamp of last successful authentication';
