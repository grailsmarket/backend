-- Add tier_id columns to track contract-level uint256 tier IDs

-- user_subscriptions: add tier_id
ALTER TABLE user_subscriptions ADD COLUMN tier_id INTEGER;
UPDATE user_subscriptions SET tier_id = CASE WHEN tier = 'pro' THEN 1 ELSE 0 END;
ALTER TABLE user_subscriptions ALTER COLUMN tier_id SET NOT NULL;
ALTER TABLE user_subscriptions ALTER COLUMN tier_id SET DEFAULT 0;

-- users: add tier_id
ALTER TABLE users ADD COLUMN tier_id INTEGER;
UPDATE users SET tier_id = CASE WHEN tier = 'pro' THEN 1 ELSE 0 END;
ALTER TABLE users ALTER COLUMN tier_id SET NOT NULL;
ALTER TABLE users ALTER COLUMN tier_id SET DEFAULT 0;

-- Expand tier CHECK to allow future tier names
ALTER TABLE user_subscriptions DROP CONSTRAINT valid_tier;
ALTER TABLE user_subscriptions ADD CONSTRAINT valid_tier
  CHECK (tier IN ('free', 'pro', 'premium'));

-- Add 'superseded' status for upgrade handling
ALTER TABLE user_subscriptions DROP CONSTRAINT valid_sub_status;
ALTER TABLE user_subscriptions ADD CONSTRAINT valid_sub_status
  CHECK (status IN ('active', 'expired', 'cancelled', 'superseded'));

-- Indexes
CREATE INDEX idx_users_tier_id ON users(tier_id);
CREATE INDEX idx_user_subscriptions_tier_id ON user_subscriptions(tier_id);
