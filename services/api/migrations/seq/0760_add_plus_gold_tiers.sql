-- Expand tier CHECK constraint to include plus and gold tiers
-- Tier mapping: 0=free, 1=pro, 2=plus, 3=gold

ALTER TABLE user_subscriptions DROP CONSTRAINT valid_tier;
ALTER TABLE user_subscriptions ADD CONSTRAINT valid_tier
  CHECK (tier IN ('free', 'pro', 'plus', 'gold'));
