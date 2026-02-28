-- Migration: Fix clubs trigger to handle ON CONFLICT DO UPDATE upserts
-- Description: The indexer typically creates ens_names rows with a 'token-XXX' placeholder
--   via a Transfer event, then NameRegistered arrives and does ON CONFLICT (token_id) DO UPDATE
--   to set the real name. The BEFORE INSERT trigger from 0630 fires but its clubs value is
--   discarded because the UPDATE SET clause doesn't include clubs. Fix: add BEFORE UPDATE
--   so clubs are populated when the name changes from a placeholder to the real name.
-- Date: 2026-02-27

-- ============================================================================
-- STEP 1: Drop old INSERT-only trigger
-- ============================================================================
DROP TRIGGER IF EXISTS set_clubs_on_ens_name_insert ON ens_names;

-- ============================================================================
-- STEP 2: Replace function to handle both INSERT and UPDATE
-- ============================================================================
CREATE OR REPLACE FUNCTION populate_clubs_on_ens_name_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name) THEN
    NEW.clubs = (
      SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
      FROM club_memberships
      WHERE LOWER(ens_name) = LOWER(NEW.name)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 3: Create trigger for both INSERT and UPDATE
-- ============================================================================
CREATE TRIGGER set_clubs_on_ens_name_insert_or_update
  BEFORE INSERT OR UPDATE ON ens_names
  FOR EACH ROW
  EXECUTE FUNCTION populate_clubs_on_ens_name_insert();

COMMENT ON FUNCTION populate_clubs_on_ens_name_insert() IS 'Populates clubs array from club_memberships on INSERT or when name changes on UPDATE';

-- ============================================================================
-- STEP 4: Backfill any names that slipped through between 0630 and this fix
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
