-- Add premium and available name counts to clubs table for sorting
-- These are calculated hourly by the club-stats worker

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS premium_count INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS available_count INT DEFAULT 0;

-- Add indexes for efficient sorting
CREATE INDEX IF NOT EXISTS idx_clubs_premium_count ON clubs(premium_count);
CREATE INDEX IF NOT EXISTS idx_clubs_available_count ON clubs(available_count);

-- Note: Initial population will be done by the hourly club stats worker
-- or can be triggered manually via pg-boss job
