-- Add last_sale_price, last_sale_currency, and last_sale_price_usd to ens_names table
-- Migration: add_last_sale_price
-- Created: 2025-10-27
-- IMPORTANT: This migration depends on:
--   1. sales table existing (run create_sales_table.sql first)
--   2. price_feeds table existing (run create_price_feeds_table.sql first)

-- Add columns for last sale tracking
ALTER TABLE ens_names
ADD COLUMN IF NOT EXISTS last_sale_price VARCHAR(78) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_sale_currency VARCHAR(42) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_sale_price_usd NUMERIC(20, 2) DEFAULT NULL;

-- Create indexes for performance
-- Index for sorting by USD price
CREATE INDEX IF NOT EXISTS idx_ens_names_last_sale_price_usd
ON ens_names(last_sale_price_usd DESC NULLS LAST)
WHERE last_sale_price_usd IS NOT NULL;

-- Index for filtering by currency
CREATE INDEX IF NOT EXISTS idx_ens_names_last_sale_currency
ON ens_names(last_sale_currency)
WHERE last_sale_currency IS NOT NULL;

-- Add comments
COMMENT ON COLUMN ens_names.last_sale_price IS 'Price in wei/smallest units of the most recent sale (denormalized from sales table)';
COMMENT ON COLUMN ens_names.last_sale_currency IS 'Currency address of the most recent sale (0x0 for ETH)';
COMMENT ON COLUMN ens_names.last_sale_price_usd IS 'USD value of the most recent sale in cents (e.g., 320000 = $3,200.00)';

-- Helper function to get latest ETH price from price_feeds table
CREATE OR REPLACE FUNCTION get_latest_eth_usd_price()
RETURNS NUMERIC AS $$
DECLARE
  eth_price NUMERIC;
BEGIN
  -- Get most recent ETH price from our database
  SELECT price INTO eth_price
  FROM latest_prices
  WHERE token_symbol = 'ETH' AND quote_currency = 'USD';

  -- If no price found, get the most recent price from price_feeds directly
  IF eth_price IS NULL THEN
    SELECT price INTO eth_price
    FROM price_feeds
    WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
    ORDER BY timestamp DESC
    LIMIT 1;
  END IF;

  RETURN eth_price;
END;
$$ LANGUAGE plpgsql;

-- Helper function to calculate USD value based on price, currency, and ETH price
CREATE OR REPLACE FUNCTION calculate_usd_value(
  price_wei VARCHAR(78),
  currency_address VARCHAR(42),
  eth_usd_price NUMERIC
)
RETURNS NUMERIC AS $$
DECLARE
  usd_value NUMERIC(20, 2);
  price_numeric NUMERIC;
BEGIN
  -- Convert price from string to numeric
  price_numeric := CAST(price_wei AS NUMERIC);

  -- Calculate USD value based on currency
  IF currency_address = '0x0000000000000000000000000000000000000000' THEN
    -- Native ETH (18 decimals)
    -- Convert wei to ETH, multiply by USD price, convert to cents
    usd_value := ROUND((price_numeric / 1e18) * eth_usd_price * 100, 2);

  ELSIF LOWER(currency_address) = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' THEN
    -- WETH (18 decimals) - same as ETH
    usd_value := ROUND((price_numeric / 1e18) * eth_usd_price * 100, 2);

  ELSIF LOWER(currency_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' THEN
    -- USDC (6 decimals) - already in USD, just convert to cents
    usd_value := ROUND((price_numeric / 1e6) * 100, 2);

  ELSE
    -- Unknown currency, return NULL
    usd_value := NULL;
  END IF;

  RETURN usd_value;
END;
$$ LANGUAGE plpgsql;

-- Trigger function to automatically update last sale data when new sale is recorded
CREATE OR REPLACE FUNCTION update_ens_name_last_sale_with_usd()
RETURNS TRIGGER AS $$
DECLARE
  eth_price NUMERIC;
  usd_value NUMERIC(20, 2);
BEGIN
  -- Get current ETH price from our database
  eth_price := get_latest_eth_usd_price();

  -- Calculate USD value (returns NULL for unknown currencies or if no ETH price)
  IF eth_price IS NOT NULL THEN
    usd_value := calculate_usd_value(NEW.sale_price_wei, NEW.currency_address, eth_price);
  ELSE
    usd_value := NULL;
  END IF;

  -- Update ens_names with latest sale data
  -- Only update if this is a more recent sale (or if no sale date exists)
  UPDATE ens_names
  SET
    last_sale_price = NEW.sale_price_wei,
    last_sale_currency = NEW.currency_address,
    last_sale_price_usd = usd_value,
    updated_at = NOW()
  WHERE id = NEW.ens_name_id
    AND (last_sale_date IS NULL OR NEW.sale_date >= last_sale_date);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update last sale data on new sales
DROP TRIGGER IF EXISTS update_last_sale_with_usd ON sales;
CREATE TRIGGER update_last_sale_with_usd
    AFTER INSERT ON sales
    FOR EACH ROW
    EXECUTE FUNCTION update_ens_name_last_sale_with_usd();

-- Backfill last_sale_price, last_sale_currency, and last_sale_price_usd from existing sales data
-- This gets the most recent sale for each name and calculates USD value
DO $$
DECLARE
  eth_price NUMERIC;
  update_count INTEGER := 0;
BEGIN
  -- Get current ETH price for backfill
  eth_price := get_latest_eth_usd_price();

  IF eth_price IS NULL THEN
    RAISE WARNING 'No ETH price found in price_feeds table. USD values will be NULL. Run price fetcher worker to populate prices.';
  ELSE
    RAISE NOTICE 'Using ETH price: $% for backfill', eth_price;
  END IF;

  -- Update ens_names with most recent sale data
  UPDATE ens_names en
  SET
    last_sale_price = s.sale_price_wei,
    last_sale_currency = s.currency_address,
    last_sale_price_usd = CASE
      WHEN eth_price IS NOT NULL THEN calculate_usd_value(s.sale_price_wei, s.currency_address, eth_price)
      ELSE NULL
    END
  FROM (
    SELECT DISTINCT ON (ens_name_id)
      ens_name_id,
      sale_price_wei,
      currency_address,
      sale_date
    FROM sales
    ORDER BY ens_name_id, sale_date DESC
  ) s
  WHERE en.id = s.ens_name_id
    AND EXISTS (
      SELECT 1 FROM sales WHERE ens_name_id = en.id
    );

  GET DIAGNOSTICS update_count = ROW_COUNT;

  RAISE NOTICE 'Backfilled % ENS names with last sale data', update_count;
END $$;

-- Verify the migration
DO $$
DECLARE
    sale_count INTEGER;
    updated_count INTEGER;
    usd_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO sale_count FROM sales;
    SELECT COUNT(*) INTO updated_count FROM ens_names WHERE last_sale_price IS NOT NULL;
    SELECT COUNT(*) INTO usd_count FROM ens_names WHERE last_sale_price_usd IS NOT NULL;

    RAISE NOTICE 'Migration completed:';
    RAISE NOTICE '  - Total sales in database: %', sale_count;
    RAISE NOTICE '  - ENS names with last_sale_price: %', updated_count;
    RAISE NOTICE '  - ENS names with last_sale_price_usd: %', usd_count;
    RAISE NOTICE '  - Triggers created: update_last_sale_with_usd';
    RAISE NOTICE '  - Helper functions: get_latest_eth_usd_price(), calculate_usd_value()';
END $$;
