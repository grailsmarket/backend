-- Migration: Realign subscription tier name strings to canonical tier_id mapping
-- Canonical: 0=free, 1=plus, 2=pro, 3=gold
-- Prior to this, services/shared/src/constants/tiers.ts had TIER_MAP inverted
-- (1=pro, 2=plus), so rows inserted via the indexer or admin_grant ended up with
-- tier strings that disagree with the on-chain tier_id. This migration realigns
-- the denormalized tier name column to match tier_id.

BEGIN;

UPDATE user_subscriptions SET tier = 'plus' WHERE tier_id = 1 AND tier = 'pro';
UPDATE user_subscriptions SET tier = 'pro'  WHERE tier_id = 2 AND tier = 'plus';

UPDATE users SET tier = 'plus' WHERE tier_id = 1 AND tier = 'pro';
UPDATE users SET tier = 'pro'  WHERE tier_id = 2 AND tier = 'plus';

COMMIT;
