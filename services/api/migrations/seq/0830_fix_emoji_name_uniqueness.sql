-- Fix emoji name uniqueness
-- Migration: fix_emoji_name_uniqueness
-- Created: 2026-04-09
--
-- Problem: The partial unique index from migration 0040 uses regex '^[a-z0-9-]+\.eth$'
-- which excludes emoji/unicode names from uniqueness protection. This allows duplicate
-- ens_names rows for emoji names (e.g., keycap emoji like 3⃣6⃣.eth), causing token_id
-- constraint violations during wrap/unwrap transitions and incorrect ownership data.
--
-- Fix: Replace the regex-based partial index with a negative-condition index that covers
-- ALL non-placeholder names (including emoji/unicode). Deduplicate existing duplicates first.

-- Step 1: Deduplicate existing non-ASCII name duplicates
-- For each set of duplicates, keep the row with the most activity (FK references),
-- migrate FKs from extras to the keeper, then delete the extras.
DO $$
DECLARE
  dup RECORD;
  keeper_id INTEGER;
  extra_ids INTEGER[];
  extra_id INTEGER;
BEGIN
  -- Find all duplicate names that are NOT covered by the current partial index
  -- (i.e., names with emoji/unicode characters that bypassed uniqueness)
  FOR dup IN
    SELECT name, array_agg(id ORDER BY id) as ids
    FROM ens_names
    WHERE name NOT LIKE 'token-%'
      AND name NOT LIKE '#%'
      AND name NOT LIKE '[%].eth'
    GROUP BY name
    HAVING COUNT(*) > 1
  LOOP
    -- Pick the keeper: the row with the most FK references, or lowest id as tiebreaker
    SELECT id INTO keeper_id
    FROM (
      SELECT e.id,
        (SELECT COUNT(*) FROM listings WHERE ens_name_id = e.id) +
        (SELECT COUNT(*) FROM offers WHERE ens_name_id = e.id) +
        (SELECT COUNT(*) FROM sales WHERE ens_name_id = e.id) as activity_count
      FROM ens_names e
      WHERE e.id = ANY(dup.ids)
      ORDER BY activity_count DESC, e.id ASC
      LIMIT 1
    ) sub;

    extra_ids := array_remove(dup.ids, keeper_id);

    RAISE NOTICE 'Deduplicating "%": keeping id %, removing ids %', dup.name, keeper_id, extra_ids;

    -- Disable triggers for this block to avoid side effects during FK migration
    SET LOCAL session_replication_role = replica;

    FOREACH extra_id IN ARRAY extra_ids
    LOOP
      -- Tables without ens_name_id in unique constraint: direct UPDATE
      UPDATE listings SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;
      UPDATE offers SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;
      UPDATE activity_history SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;
      UPDATE notifications SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- Tables WITH ens_name_id in a unique constraint: delete conflicts first, then UPDATE
      -- watchlist: UNIQUE(user_id, ens_name_id)
      DELETE FROM watchlist WHERE ens_name_id = extra_id
        AND user_id IN (SELECT user_id FROM watchlist WHERE ens_name_id = keeper_id);
      UPDATE watchlist SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- sales: UNIQUE(transaction_hash, ens_name_id)
      DELETE FROM sales WHERE ens_name_id = extra_id
        AND transaction_hash IN (SELECT transaction_hash FROM sales WHERE ens_name_id = keeper_id);
      UPDATE sales SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- name_views: UNIQUE(ens_name_id, viewer_identifier)
      DELETE FROM name_views WHERE ens_name_id = extra_id
        AND viewer_identifier IN (SELECT viewer_identifier FROM name_views WHERE ens_name_id = keeper_id);
      UPDATE name_views SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- name_votes: UNIQUE(ens_name_id, user_id)
      DELETE FROM name_votes WHERE ens_name_id = extra_id
        AND user_id IN (SELECT user_id FROM name_votes WHERE ens_name_id = keeper_id);
      UPDATE name_votes SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- cart_items: UNIQUE(user_id, ens_name_id, cart_type_id)
      DELETE FROM cart_items WHERE ens_name_id = extra_id
        AND (user_id, cart_type_id) IN (
          SELECT user_id, cart_type_id FROM cart_items WHERE ens_name_id = keeper_id
        );
      UPDATE cart_items SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- registrations: UNIQUE(transaction_hash, ens_name_id)
      DELETE FROM registrations WHERE ens_name_id = extra_id
        AND transaction_hash IN (SELECT transaction_hash FROM registrations WHERE ens_name_id = keeper_id);
      UPDATE registrations SET ens_name_id = keeper_id WHERE ens_name_id = extra_id;

      -- Delete the duplicate row (transactions will cascade-delete)
      DELETE FROM ens_names WHERE id = extra_id;
    END LOOP;

    -- Re-enable triggers
    SET LOCAL session_replication_role = DEFAULT;

    -- Recalculate denormalized counts on the keeper
    UPDATE ens_names SET
      view_count = (SELECT COUNT(*) FROM name_views WHERE ens_name_id = keeper_id),
      upvotes = (SELECT COUNT(*) FROM name_votes WHERE ens_name_id = keeper_id AND vote = 1),
      downvotes = (SELECT COUNT(*) FROM name_votes WHERE ens_name_id = keeper_id AND vote = -1),
      net_score = (SELECT COALESCE(SUM(vote), 0) FROM name_votes WHERE ens_name_id = keeper_id)
    WHERE id = keeper_id;
  END LOOP;
END $$;

-- Step 2: Drop the old partial unique index
DROP INDEX IF EXISTS ens_names_real_name_unique;

-- Step 3: Create a new partial unique index that covers ALL non-placeholder names
-- This includes emoji, unicode, and any other valid ENS name format
CREATE UNIQUE INDEX ens_names_real_name_unique
ON ens_names(name)
WHERE name NOT LIKE 'token-%' AND name NOT LIKE '#%' AND name NOT LIKE '[%].eth';

COMMENT ON INDEX ens_names_real_name_unique IS
  'Ensures uniqueness of all real ENS names while allowing placeholder duplicates. Covers emoji/unicode names that were previously excluded by the ASCII-only regex.';
