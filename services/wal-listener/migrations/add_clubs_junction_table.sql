-- Migration: Add clubs system with junction table
-- Description: Adds support for categorizing ENS names into clubs using a scalable junction table approach
-- Date: 2025-01-13
-- Architecture: club_memberships (source of truth) → trigger → ens_names.clubs (denormalized cache)

-- ============================================================================
-- STEP 1: Add clubs column to ens_names (denormalized cache for fast reads)
-- ============================================================================
ALTER TABLE ens_names
ADD COLUMN IF NOT EXISTS clubs TEXT[];

-- Create index for club searches
CREATE INDEX IF NOT EXISTS idx_ens_names_clubs
ON ens_names USING GIN (clubs);

COMMENT ON COLUMN ens_names.clubs IS 'Denormalized array of club names (auto-synced from club_memberships table)';

-- ============================================================================
-- STEP 2: Create clubs metadata table
-- ============================================================================
CREATE TABLE IF NOT EXISTS clubs (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  member_count INT DEFAULT 0
);

COMMENT ON TABLE clubs IS 'Club metadata and definitions';

-- ============================================================================
-- STEP 3: Create club_memberships junction table (source of truth)
-- ============================================================================
CREATE TABLE IF NOT EXISTS club_memberships (
  club_name TEXT NOT NULL REFERENCES clubs(name) ON DELETE CASCADE,
  ens_name TEXT NOT NULL,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (club_name, ens_name)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_club_memberships_ens_name
ON club_memberships(LOWER(ens_name));

CREATE INDEX IF NOT EXISTS idx_club_memberships_club_name
ON club_memberships(club_name);

COMMENT ON TABLE club_memberships IS 'Junction table mapping ENS names to clubs (source of truth)';

-- ============================================================================
-- STEP 4: Trigger to auto-sync club_memberships → ens_names.clubs
-- ============================================================================
CREATE OR REPLACE FUNCTION sync_clubs_to_ens_names()
RETURNS TRIGGER AS $$
DECLARE
  target_name TEXT;
BEGIN
  -- Determine which ens_name was affected
  IF TG_OP = 'DELETE' THEN
    target_name := OLD.ens_name;
  ELSE
    target_name := NEW.ens_name;
  END IF;

  -- Update the denormalized clubs array in ens_names
  UPDATE ens_names
  SET clubs = (
    SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
    FROM club_memberships
    WHERE LOWER(ens_name) = LOWER(ens_names.name)
  )
  WHERE LOWER(name) = LOWER(target_name);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_ens_clubs_on_membership_change
  AFTER INSERT OR UPDATE OR DELETE ON club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION sync_clubs_to_ens_names();

COMMENT ON FUNCTION sync_clubs_to_ens_names() IS 'Auto-syncs club_memberships changes to ens_names.clubs array';

-- ============================================================================
-- STEP 5: Trigger to update club member counts
-- ============================================================================
CREATE OR REPLACE FUNCTION update_club_member_count()
RETURNS TRIGGER AS $$
DECLARE
  affected_club TEXT;
BEGIN
  -- Determine which club was affected
  IF TG_OP = 'DELETE' THEN
    affected_club := OLD.club_name;
  ELSE
    affected_club := NEW.club_name;
  END IF;

  -- Update member count and updated_at timestamp
  UPDATE clubs
  SET
    member_count = (
      SELECT COUNT(*)
      FROM club_memberships
      WHERE club_name = affected_club
    ),
    updated_at = NOW()
  WHERE name = affected_club;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_club_count_on_membership_change
  AFTER INSERT OR DELETE ON club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_club_member_count();

COMMENT ON FUNCTION update_club_member_count() IS 'Updates club member_count when memberships change';

-- ============================================================================
-- DONE: The system is now ready to use
-- ============================================================================
-- Usage:
--   1. INSERT INTO clubs (name, description) VALUES ('example-club', 'Description of club');
--   2. INSERT INTO club_memberships (club_name, ens_name) VALUES ('example-club', 'name.eth');
--   3. The triggers will automatically update ens_names.clubs and clubs.member_count
--   4. WAL listener will detect changes and sync to Elasticsearch
