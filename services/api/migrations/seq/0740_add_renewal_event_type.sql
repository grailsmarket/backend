-- Migration: 0740_add_renewal_event_type
-- Description: Add 'renewal' to activity_event_type enum for tracking ENS name renewals in activity history.

ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'renewal';
