-- Migration: Normalize club_memberships.ens_name to lowercase
-- Fixes: Mixed-case ens_name values (e.g. 'Sing.eth' vs 'sing.eth') cause non-deterministic
--   backfill results in 0640's UPDATE...FROM, which groups by case-sensitive ens_name but
--   joins case-insensitively. PostgreSQL picks an arbitrary group when multiple match.
-- Date: 2026-03-09

-- Step 1: Remove duplicates that would conflict after lowercasing.
-- When both 'Sing.eth' and 'sing.eth' exist for the same club, keep the earlier one.
-- Tiebreaker on ens_name to handle identical added_at values.
DELETE FROM club_memberships cm1
USING club_memberships cm2
WHERE cm1.club_name = cm2.club_name
  AND LOWER(cm1.ens_name) = LOWER(cm2.ens_name)
  AND cm1.ens_name != cm2.ens_name
  AND (cm1.added_at > cm2.added_at
       OR (cm1.added_at = cm2.added_at AND cm1.ens_name > cm2.ens_name));

-- Step 2: Lowercase all ens_name values
UPDATE club_memberships
SET ens_name = LOWER(ens_name)
WHERE ens_name != LOWER(ens_name);

-- Step 3: Add a CHECK constraint to prevent future mixed-case entries
ALTER TABLE club_memberships
ADD CONSTRAINT club_memberships_ens_name_lowercase
CHECK (ens_name = LOWER(ens_name));

-- Step 4: Re-sync ens_names.clubs from the now-normalized data
UPDATE ens_names en
SET clubs = sub.expected_clubs
FROM (
  SELECT cm.ens_name, array_agg(cm.club_name) AS expected_clubs
  FROM club_memberships cm
  GROUP BY cm.ens_name
) sub
WHERE LOWER(en.name) = sub.ens_name
  AND (en.clubs IS DISTINCT FROM sub.expected_clubs);

-- Step 5: Clear orphaned clubs (ens_names with clubs but no memberships)
UPDATE ens_names en
SET clubs = NULL
WHERE en.clubs IS NOT NULL
  AND array_length(en.clubs, 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM club_memberships cm WHERE cm.ens_name = LOWER(en.name)
  );
