-- Backfill USD prices for all sales
-- Script: backfill_sale_usd_prices.sql
-- Purpose: Recalculate last_sale_price_usd for all ENS names based on current price_feeds data
-- Run this if:
--   - Price feed data was corrected/updated
--   - USD values are NULL and need recalculation
--   - ETH price was wrong and needs fixing

-- This script can be run multiple times safely (idempotent)

DO $$
DECLARE
  eth_price NUMERIC;
  update_count INTEGER := 0;
  total_names INTEGER := 0;
  null_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Starting USD price backfill...';

  -- Get current ETH price
  eth_price := get_latest_eth_usd_price();

  IF eth_price IS NULL THEN
    RAISE EXCEPTION 'No ETH price found in price_feeds table. Run price fetcher worker first.';
  END IF;

  RAISE NOTICE 'Using ETH price: $%', eth_price;

  -- Count total names with sales
  SELECT COUNT(*) INTO total_names
  FROM ens_names
  WHERE last_sale_price IS NOT NULL;

  RAISE NOTICE 'Found % ENS names with sale data', total_names;

  -- Count names with NULL USD values
  SELECT COUNT(*) INTO null_count
  FROM ens_names
  WHERE last_sale_price IS NOT NULL AND last_sale_price_usd IS NULL;

  IF null_count > 0 THEN
    RAISE NOTICE '% names have NULL USD values', null_count;
  END IF;

  -- Update all ENS names with recalculated USD values
  UPDATE ens_names
  SET
    last_sale_price_usd = calculate_usd_value(
      last_sale_price,
      last_sale_currency,
      eth_price
    ),
    updated_at = NOW()
  WHERE last_sale_price IS NOT NULL
    AND last_sale_currency IS NOT NULL;

  GET DIAGNOSTICS update_count = ROW_COUNT;

  RAISE NOTICE 'Updated % ENS names with recalculated USD prices', update_count;

  -- Show summary statistics
  RAISE NOTICE '';
  RAISE NOTICE '=== Backfill Summary ===';
  RAISE NOTICE 'ETH/USD Price Used: $%', eth_price;
  RAISE NOTICE 'Total Names Processed: %', update_count;
  RAISE NOTICE 'Names Still NULL: %', (
    SELECT COUNT(*)
    FROM ens_names
    WHERE last_sale_price IS NOT NULL AND last_sale_price_usd IS NULL
  );

  -- Show breakdown by currency
  RAISE NOTICE '';
  RAISE NOTICE '=== Currency Breakdown ===';
  FOR currency_record IN (
    SELECT
      CASE
        WHEN last_sale_currency = '0x0000000000000000000000000000000000000000' THEN 'ETH'
        WHEN LOWER(last_sale_currency) = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' THEN 'WETH'
        WHEN LOWER(last_sale_currency) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' THEN 'USDC'
        ELSE 'OTHER'
      END as currency_name,
      COUNT(*) as count,
      AVG(last_sale_price_usd / 100.0) as avg_usd,
      MIN(last_sale_price_usd / 100.0) as min_usd,
      MAX(last_sale_price_usd / 100.0) as max_usd
    FROM ens_names
    WHERE last_sale_price IS NOT NULL AND last_sale_currency IS NOT NULL
    GROUP BY
      CASE
        WHEN last_sale_currency = '0x0000000000000000000000000000000000000000' THEN 'ETH'
        WHEN LOWER(last_sale_currency) = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' THEN 'WETH'
        WHEN LOWER(last_sale_currency) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' THEN 'USDC'
        ELSE 'OTHER'
      END
    ORDER BY count DESC
  ) LOOP
    RAISE NOTICE '  %: % sales (avg: $%, min: $%, max: $%)',
      RPAD(currency_record.currency_name, 6),
      currency_record.count,
      ROUND(currency_record.avg_usd, 2),
      ROUND(currency_record.min_usd, 2),
      ROUND(currency_record.max_usd, 2);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Backfill completed successfully!';
END $$;
