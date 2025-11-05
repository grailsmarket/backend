-- Migration: Convert activity_history.created_at to TIMESTAMPTZ
-- This ensures all timestamps are stored in UTC and properly timezone-aware

-- Alter the column to use TIMESTAMPTZ (timestamp with timezone)
-- PostgreSQL will automatically convert existing TIMESTAMP values to TIMESTAMPTZ
-- assuming they are in the server's current timezone
ALTER TABLE activity_history
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- Update the default to use timezone-aware NOW()
ALTER TABLE activity_history
  ALTER COLUMN created_at SET DEFAULT NOW();

-- Add comment
COMMENT ON COLUMN activity_history.created_at IS 'Timestamp when the activity occurred (stored in UTC)';
