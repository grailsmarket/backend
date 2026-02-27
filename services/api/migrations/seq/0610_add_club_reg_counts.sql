-- Migration: Add registration count columns to clubs table
-- Adds time-based registration count statistics (rolling windows)

-- Registration count columns
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_reg_count INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_count_1y INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_count_1mo INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_count_1w INT DEFAULT 0;

-- Indexes for sorting (B-tree for numeric comparisons)
CREATE INDEX IF NOT EXISTS idx_clubs_total_reg_count ON clubs (total_reg_count DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_reg_count_1y ON clubs (reg_count_1y DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_reg_count_1mo ON clubs (reg_count_1mo DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_reg_count_1w ON clubs (reg_count_1w DESC NULLS LAST);

-- Column comments
COMMENT ON COLUMN clubs.total_reg_count IS 'Total registration count for club members (all time)';
COMMENT ON COLUMN clubs.reg_count_1y IS 'Registration count for past 365 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.reg_count_1mo IS 'Registration count for past 30 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.reg_count_1w IS 'Registration count for past 7 days (rolling window, recalculated hourly)';
