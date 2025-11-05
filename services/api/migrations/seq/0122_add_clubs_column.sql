-- Migration: Add clubs column to ens_names table
-- Description: Adds support for categorizing ENS names into clubs (e.g., crypto-terms, brands, etc.)
-- Date: 2025-01-13

-- Add clubs column
ALTER TABLE ens_names
ADD COLUMN IF NOT EXISTS clubs TEXT[];

-- Create index for club searches
CREATE INDEX IF NOT EXISTS idx_ens_names_clubs
ON ens_names USING GIN (clubs);

-- Add comment
COMMENT ON COLUMN ens_names.clubs IS 'Array of club names this ENS name belongs to (e.g., brands, crypto-terms)';
