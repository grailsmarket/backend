-- Allow 'cancelled' offers.
--
-- An offer on an ENSv2 name references the name's token ID, which changes when roles on the
-- name change or when a v1 name migrates; the old offer can then never be filled. Such offers
-- are cancelled (not 'unfunded', which the balance revalidator would restore to 'pending').
-- Same list as before plus 'cancelled'.

ALTER TABLE offers DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE offers ADD CONSTRAINT valid_status CHECK (
  status IN ('pending', 'accepted', 'rejected', 'expired', 'unfunded', 'cancelled')
);
