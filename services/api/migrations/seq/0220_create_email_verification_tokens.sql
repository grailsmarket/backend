-- Create email verification tokens table
CREATE TABLE email_verification_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,  -- Crypto-random token
  email VARCHAR(255) NOT NULL,         -- Email being verified
  expires_at TIMESTAMP NOT NULL,       -- Tokens expire after 24 hours
  created_at TIMESTAMP DEFAULT NOW(),
  used_at TIMESTAMP                    -- NULL until verified
);

CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token) WHERE used_at IS NULL;
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
CREATE INDEX idx_email_verification_tokens_expires_at ON email_verification_tokens(expires_at) WHERE used_at IS NULL;

COMMENT ON TABLE email_verification_tokens IS 'Tokens for verifying user email addresses';
COMMENT ON COLUMN email_verification_tokens.token IS 'Cryptographically secure random token (URL-safe)';
COMMENT ON COLUMN email_verification_tokens.used_at IS 'Timestamp when token was used (NULL = unused)';
