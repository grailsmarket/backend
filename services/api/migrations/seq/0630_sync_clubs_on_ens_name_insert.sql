-- Migration: Populate clubs from club_memberships when a new ens_names row is created
-- Description: Fixes issue where newly registered names that already exist in club_memberships
--   get NULL clubs because the existing sync trigger only fires on club_memberships changes,
--   not on ens_names inserts.
-- Date: 2026-02-27

-- ============================================================================
-- STEP 1: BEFORE INSERT trigger on ens_names to populate clubs
-- ============================================================================
CREATE OR REPLACE FUNCTION populate_clubs_on_ens_name_insert()
RETURNS TRIGGER AS $$
BEGIN
  NEW.clubs = (
    SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
    FROM club_memberships
    WHERE LOWER(ens_name) = LOWER(NEW.name)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_clubs_on_ens_name_insert
  BEFORE INSERT ON ens_names
  FOR EACH ROW
  EXECUTE FUNCTION populate_clubs_on_ens_name_insert();

COMMENT ON FUNCTION populate_clubs_on_ens_name_insert() IS 'Populates clubs array from club_memberships when a new ens_names row is inserted';

-- ============================================================================
-- STEP 2: Backfill existing names with stale/NULL clubs
-- ============================================================================
UPDATE ens_names en
SET clubs = sub.expected_clubs
FROM (
  SELECT cm.ens_name, array_agg(cm.club_name) AS expected_clubs
  FROM club_memberships cm
  GROUP BY cm.ens_name
) sub
WHERE LOWER(en.name) = LOWER(sub.ens_name)
  AND (en.clubs IS NULL OR en.clubs != sub.expected_clubs);
