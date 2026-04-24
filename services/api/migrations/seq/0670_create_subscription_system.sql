-- Migration: Create subscription system for Grails PRO tier
-- Created: 2026-03-09

-- Subscription records
CREATE TABLE user_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier VARCHAR(20) NOT NULL DEFAULT 'free',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    payment_method VARCHAR(20),
    payment_tx_hash VARCHAR(66),
    payment_amount_wei VARCHAR(78),
    granted_by INTEGER REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_tier CHECK (tier IN ('free', 'pro')),
    CONSTRAINT valid_sub_status CHECK (status IN ('active', 'expired', 'cancelled'))
);

-- Denormalized tier fields on users for fast JWT lookups
ALTER TABLE users ADD COLUMN tier VARCHAR(20) NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN tier_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Indexes
CREATE INDEX idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX idx_user_subscriptions_active_expiry ON user_subscriptions(expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX idx_users_tier ON users(tier);

-- updated_at trigger for user_subscriptions
CREATE TRIGGER update_user_subscriptions_updated_at
    BEFORE UPDATE ON user_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
