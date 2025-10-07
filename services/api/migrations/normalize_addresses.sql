-- Normalize all addresses to lowercase for consistent lookups
-- Run this migration to fix existing data

-- Normalize addresses in listings table
UPDATE listings
SET seller_address = LOWER(seller_address)
WHERE seller_address IS NOT NULL
  AND seller_address != LOWER(seller_address);

UPDATE listings
SET currency_address = LOWER(currency_address)
WHERE currency_address IS NOT NULL
  AND currency_address != LOWER(currency_address);

-- Normalize addresses in offers table
UPDATE offers
SET buyer_address = LOWER(buyer_address)
WHERE buyer_address IS NOT NULL
  AND buyer_address != LOWER(buyer_address);

UPDATE offers
SET currency_address = LOWER(currency_address)
WHERE currency_address IS NOT NULL
  AND currency_address != LOWER(currency_address);

-- Normalize addresses in ens_names table
UPDATE ens_names
SET owner_address = LOWER(owner_address)
WHERE owner_address IS NOT NULL
  AND owner_address != LOWER(owner_address);

UPDATE ens_names
SET resolver_address = LOWER(resolver_address)
WHERE resolver_address IS NOT NULL
  AND resolver_address != LOWER(resolver_address);

-- Add indexes to improve lookup performance on normalized addresses
CREATE INDEX IF NOT EXISTS idx_listings_seller_address_lower ON listings(LOWER(seller_address));
CREATE INDEX IF NOT EXISTS idx_offers_buyer_address_lower ON offers(LOWER(buyer_address));
CREATE INDEX IF NOT EXISTS idx_ens_names_owner_address_lower ON ens_names(LOWER(owner_address));

-- Show results
SELECT
  'listings' as table_name,
  COUNT(*) as total_rows,
  COUNT(DISTINCT seller_address) as unique_sellers
FROM listings
UNION ALL
SELECT
  'offers' as table_name,
  COUNT(*) as total_rows,
  COUNT(DISTINCT buyer_address) as unique_buyers
FROM offers
UNION ALL
SELECT
  'ens_names' as table_name,
  COUNT(*) as total_rows,
  COUNT(DISTINCT owner_address) as unique_owners
FROM ens_names;
