-- Match club memberships to ens_names by exact name, not case-insensitively.
--
-- The registrar doesn't enforce normalization, so "Jesse.eth" (label "Jesse") is a real
-- on-chain token separate from "jesse.eth". Both club triggers matched on LOWER(), so
-- these unreachable copies inherited the real name's clubs, and with them showed up on
-- category-filtered pages like Premium.
--
-- club_memberships.ens_name is always stored normalized (lowercase), so an exact match is
-- correct. The LOWER() comparison is kept alongside it so the existing
-- LOWER(...) indexes on both tables are still used.

BEGIN;

CREATE OR REPLACE FUNCTION populate_clubs_on_ens_name_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name) THEN
    NEW.clubs = (
      SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
      FROM club_memberships
      WHERE LOWER(ens_name) = LOWER(NEW.name)
        AND ens_name = NEW.name
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
      AND ens_name = ens_names.name
  )
  WHERE LOWER(name) = LOWER(target_name)
    AND name = target_name;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Clear clubs already copied onto non-lowercase names (7 rows in prod on 2026-11-03:
-- openseA, ViTalIKButERiN, Hayden, Jesse, KEVIN, VLAD, Vlad). Recomputed with the new rule,
-- so a name that genuinely has memberships keeps them. The notify trigger pushes each
-- change to Elasticsearch.
UPDATE ens_names en
SET clubs = (
  SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
  FROM club_memberships
  WHERE LOWER(ens_name) = LOWER(en.name)
    AND ens_name = en.name
)
WHERE en.name <> LOWER(en.name)
  AND cardinality(en.clubs) > 0;

COMMIT;
