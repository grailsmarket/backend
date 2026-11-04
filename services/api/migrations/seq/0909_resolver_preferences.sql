-- Custom names for a user's ENSv2 PermissionedResolvers and their records ("configurations"),
-- and the resolver a user wants new names to use by default. Both are private to the user;
-- resolver data itself comes from the ENS worker (ensv2-records).
--
-- Purely additive: one new nullable column and one new table.

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_resolver VARCHAR(42);  -- lowercase address

-- record_id 0 names the resolver itself; 1.. name one of its records.
CREATE TABLE IF NOT EXISTS resolver_labels (
  user_id     INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolver    VARCHAR(42)    NOT NULL,  -- lowercase address
  record_id   NUMERIC(78, 0) NOT NULL DEFAULT 0,
  label       VARCHAR(64)    NOT NULL,
  created_at  TIMESTAMP      NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, resolver, record_id)
);
