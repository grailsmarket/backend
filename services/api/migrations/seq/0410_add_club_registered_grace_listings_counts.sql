-- Add registered, grace, and listings counts to clubs table for sorting
-- These are calculated hourly by the club-stats worker
--
-- registered_count: Names with expiry_date > NOW() (not expired)
-- grace_count: Names with expiry_date <= NOW() AND > NOW() - 90 days (in grace period)
-- listings_count: Names with active listings

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS registered_count INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS grace_count INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS listings_count INT DEFAULT 0;

-- Add indexes for efficient sorting
CREATE INDEX IF NOT EXISTS idx_clubs_registered_count ON clubs(registered_count);
CREATE INDEX IF NOT EXISTS idx_clubs_grace_count ON clubs(grace_count);
CREATE INDEX IF NOT EXISTS idx_clubs_listings_count ON clubs(listings_count);

-- Note: Initial population will be done by the hourly club stats worker
-- or can be triggered manually via pg-boss job
