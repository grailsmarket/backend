-- Migration: 0650_add_club_reg_volume
-- Description: Add registration volume columns to clubs table
-- Tracks total ETH spent on registrations per club across time windows

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_reg_volume_wei VARCHAR(78) DEFAULT '0';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_volume_wei_1y VARCHAR(78) DEFAULT '0';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_volume_wei_1mo VARCHAR(78) DEFAULT '0';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_volume_wei_1w VARCHAR(78) DEFAULT '0';

-- Indexes for sorting by registration volume (cast to numeric for correct ordering)
CREATE INDEX IF NOT EXISTS idx_clubs_total_reg_volume ON clubs ((total_reg_volume_wei::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_reg_volume_1y ON clubs ((reg_volume_wei_1y::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_reg_volume_1mo ON clubs ((reg_volume_wei_1mo::numeric) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_clubs_reg_volume_1w ON clubs ((reg_volume_wei_1w::numeric) DESC NULLS LAST);
