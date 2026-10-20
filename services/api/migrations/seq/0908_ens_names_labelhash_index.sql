-- Index ens_names.labelhash (set only on ENSv2 rows, from 0901).
--
-- POST /orders matches a v1 order's token ID (the labelhash) against v2 names by labelhash, to
-- reject v1 orders on names that have migrated. Partial: only v2 rows carry a labelhash.
--
-- CONCURRENTLY so it doesn't block writes to ens_names while it builds. It can't run inside a
-- transaction: run it on its own in psql autocommit mode, not wrapped in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ens_names_labelhash
  ON ens_names (labelhash)
  WHERE labelhash IS NOT NULL;
