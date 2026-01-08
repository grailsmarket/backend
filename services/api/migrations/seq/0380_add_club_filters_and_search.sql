-- Migration: Add club filtering, sorting, and search capabilities
-- Adds time-based sales statistics and classification columns to clubs table

-- Time-based sales count columns (rolling windows)
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sales_count_1y INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sales_count_1mo INT DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sales_count_1w INT DEFAULT 0;

-- Time-based volume columns (rolling windows)
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sales_volume_wei_1y VARCHAR(78) DEFAULT '0';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sales_volume_wei_1mo VARCHAR(78) DEFAULT '0';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS sales_volume_wei_1w VARCHAR(78) DEFAULT '0';

-- Classifications array for filtering (ethmojis, digits, palindromes, prepunk, geo, letters)
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS classifications TEXT[];

-- Index for classification filtering (GIN for array overlap queries)
CREATE INDEX IF NOT EXISTS idx_clubs_classifications ON clubs USING GIN (classifications);

-- Indexes for time-based sorting (B-tree for numeric comparisons)
CREATE INDEX IF NOT EXISTS idx_clubs_sales_volume_1y ON clubs ((sales_volume_wei_1y::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_sales_volume_1mo ON clubs ((sales_volume_wei_1mo::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_sales_volume_1w ON clubs ((sales_volume_wei_1w::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_sales_count_1y ON clubs (sales_count_1y DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_sales_count_1mo ON clubs (sales_count_1mo DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_sales_count_1w ON clubs (sales_count_1w DESC NULLS LAST);

-- Column comments
COMMENT ON COLUMN clubs.sales_count_1y IS 'Sales count for past 365 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.sales_count_1mo IS 'Sales count for past 30 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.sales_count_1w IS 'Sales count for past 7 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.sales_volume_wei_1y IS 'Sales volume in wei for past 365 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.sales_volume_wei_1mo IS 'Sales volume in wei for past 30 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.sales_volume_wei_1w IS 'Sales volume in wei for past 7 days (rolling window, recalculated hourly)';
COMMENT ON COLUMN clubs.classifications IS 'Array of classification categories: ethmojis, digits, palindromes, prepunk, geo, letters';
