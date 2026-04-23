-- Migration: Add audience targeting columns to admin_broadcasts. Phase 1 supports
-- 'everyone' (current behaviour) and 'specific' (addresses list). Phase 2 will add
-- 'unsubscribed' and 'tiers' without another migration.

ALTER TABLE admin_broadcasts
    ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'everyone',
    ADD COLUMN IF NOT EXISTS audience_addresses JSONB,
    ADD COLUMN IF NOT EXISTS audience_tier_ids JSONB;
