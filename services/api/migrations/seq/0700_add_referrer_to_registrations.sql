-- Migration: 0700_add_referrer_to_registrations
-- Description: Add referrer column to registrations table for tracking ENS registration referrals
-- The V2 ENS Controller emits a bytes32 referrer param in NameRegistered events

ALTER TABLE registrations ADD COLUMN referrer VARCHAR(66);
CREATE INDEX idx_registrations_referrer ON registrations(referrer);
