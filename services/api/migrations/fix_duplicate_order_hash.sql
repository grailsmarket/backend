-- Fix duplicate order hash constraint for cross-platform listings
-- When listing on both Grails and OpenSea, the same order hash is used
-- but they should be treated as separate listings

-- Drop the existing unique constraint on order_hash
ALTER TABLE listings
DROP CONSTRAINT IF EXISTS listings_order_hash_key;

ALTER TABLE listings ADD COLUMN IF NOT EXISTS source VARCHAR(20);

-- UPDATE listings SET source = 'opensea' WHERE source IS NULL;

-- -- Add a new unique constraint on (order_hash, source) combination
-- -- This allows the same order_hash on different platforms
ALTER TABLE listings
ADD CONSTRAINT listings_order_hash_source_unique
UNIQUE (order_hash, source);

CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source);

-- Show the new constraint
SELECT
  conname AS constraint_name,
  contype AS constraint_type,
  pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'listings'::regclass
  AND conname LIKE '%order_hash%';
