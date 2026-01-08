-- Migration: Convert critical TIMESTAMP columns to TIMESTAMPTZ
--
-- Problem: TIMESTAMP (without timezone) columns store values in server local time (EST/EDT),
-- but blockchain timestamps are in UTC. This causes dates to be off by 4-5 hours.
--
-- Solution: Convert to TIMESTAMPTZ and tell PostgreSQL the existing data was recorded
-- in America/New_York timezone so it can properly convert to UTC.
--
-- Note: Using AT TIME ZONE 'America/New_York' handles both EST and EDT correctly
-- based on the date being converted.

BEGIN;

-- ============================================
-- ENS Names table - core blockchain dates
-- ============================================

-- expiry_date: When the ENS name expires (from blockchain)
ALTER TABLE ens_names
  ALTER COLUMN expiry_date TYPE TIMESTAMPTZ
  USING expiry_date AT TIME ZONE 'America/New_York';

-- registration_date: When the ENS name was registered (from blockchain)
ALTER TABLE ens_names
  ALTER COLUMN registration_date TYPE TIMESTAMPTZ
  USING registration_date AT TIME ZONE 'America/New_York';

-- last_transfer_date: When the ENS name was last transferred (from blockchain)
ALTER TABLE ens_names
  ALTER COLUMN last_transfer_date TYPE TIMESTAMPTZ
  USING last_transfer_date AT TIME ZONE 'America/New_York';

-- last_sale_date: When the ENS name was last sold (from blockchain)
ALTER TABLE ens_names
  ALTER COLUMN last_sale_date TYPE TIMESTAMPTZ
  USING last_sale_date AT TIME ZONE 'America/New_York';

-- last_offer_update: When highest offer was last updated
ALTER TABLE ens_names
  ALTER COLUMN last_offer_update TYPE TIMESTAMPTZ
  USING last_offer_update AT TIME ZONE 'America/New_York';

-- ============================================
-- Sales table - blockchain sale timestamps
-- ============================================

ALTER TABLE sales
  ALTER COLUMN sale_date TYPE TIMESTAMPTZ
  USING sale_date AT TIME ZONE 'America/New_York';

-- ============================================
-- Transactions table - blockchain transaction timestamps
-- ============================================

ALTER TABLE transactions
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ
  USING timestamp AT TIME ZONE 'America/New_York';

-- ============================================
-- Listings table - expiration times
-- ============================================

-- expires_at: When the listing expires (from OpenSea/Seaport)
ALTER TABLE listings
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ
  USING expires_at AT TIME ZONE 'America/New_York';

-- ============================================
-- Offers table - expiration times
-- ============================================

-- expires_at: When the offer expires (from OpenSea/Seaport)
ALTER TABLE offers
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ
  USING expires_at AT TIME ZONE 'America/New_York';

-- ============================================
-- Price feeds table - price timestamps
-- ============================================

ALTER TABLE price_feeds
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ
  USING timestamp AT TIME ZONE 'America/New_York';

-- ============================================
-- Legends table - block timestamps
-- ============================================

ALTER TABLE legends
  ALTER COLUMN block_time TYPE TIMESTAMPTZ
  USING block_time AT TIME ZONE 'America/New_York';

-- ============================================
-- Indexer state - processing timestamps
-- ============================================

ALTER TABLE indexer_state
  ALTER COLUMN last_processed_timestamp TYPE TIMESTAMPTZ
  USING last_processed_timestamp AT TIME ZONE 'America/New_York';

-- ============================================
-- Clubs table - analytics timestamps
-- ============================================

ALTER TABLE clubs
  ALTER COLUMN last_floor_update TYPE TIMESTAMPTZ
  USING last_floor_update AT TIME ZONE 'America/New_York';

ALTER TABLE clubs
  ALTER COLUMN last_sales_update TYPE TIMESTAMPTZ
  USING last_sales_update AT TIME ZONE 'America/New_York';

COMMIT;

-- ============================================
-- Verification queries (run manually after migration)
-- ============================================

-- Check a sample of converted dates:
-- SELECT name, expiry_date, registration_date FROM ens_names WHERE expiry_date IS NOT NULL LIMIT 5;

-- Verify column types changed:
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'ens_names'
-- AND column_name IN ('expiry_date', 'registration_date', 'last_transfer_date', 'last_sale_date');
