-- Fix CSV-imported USDC sale prices
-- Migration: fix_csv_imported_usdc_sale_prices
-- Created: 2026-02-26
--
-- Problem: The CSV import script (import-sales-csv.ts) stored price_decimal as ETH wei
-- for ALL currencies. For USDC sales, this means sale_price_wei contains an ETH-scale
-- value (1e18) instead of a USDC-scale value (1e6). The DB trigger then divides by 1e6
-- producing absurdly large USD values ($billions instead of $hundreds).
--
-- The CSV import stored the correct usd_price in sales.metadata. Since USDC ≈ $1,
-- we can compute the correct 6-decimal sale_price_wei from it.
-- CSV-imported sales are identifiable by: order_data IS NULL (live ingestion always sets it).

-- Step 1: Fix sale_price_wei in the sales table for CSV-imported USDC sales
UPDATE sales
SET sale_price_wei = ROUND(CAST(metadata->>'usd_price' AS NUMERIC) * 1e6)::text
WHERE LOWER(currency_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  AND metadata IS NOT NULL
  AND metadata->>'usd_price' IS NOT NULL
  AND order_data IS NULL;

-- Step 2: Fix activity_history.price_wei for sold/bought events linked to corrected USDC sales
UPDATE activity_history ah
SET price_wei = s.sale_price_wei
FROM sales s
WHERE ah.event_type IN ('sold', 'bought')
  AND (ah.metadata->>'sale_id')::int = s.id
  AND LOWER(ah.currency_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  AND s.order_data IS NULL;

-- Step 3: Recalculate ens_names.last_sale_price + last_sale_price_usd for names
-- whose most recent sale was a USDC sale (now corrected)
DO $$
DECLARE
  eth_price NUMERIC;
  update_count INTEGER := 0;
BEGIN
  eth_price := get_latest_eth_usd_price();

  IF eth_price IS NULL THEN
    RAISE WARNING 'No ETH price found. USD values for ETH sales will be NULL.';
  END IF;

  UPDATE ens_names en
  SET
    last_sale_price = s.sale_price_wei,
    last_sale_currency = s.currency_address,
    last_sale_price_usd = CASE
      WHEN eth_price IS NOT NULL THEN calculate_usd_value(s.sale_price_wei, s.currency_address, eth_price)
      ELSE NULL
    END,
    updated_at = NOW()
  FROM (
    SELECT DISTINCT ON (ens_name_id)
      ens_name_id, sale_price_wei, currency_address, sale_date
    FROM sales
    ORDER BY ens_name_id, sale_date DESC
  ) s
  WHERE en.id = s.ens_name_id
    AND LOWER(en.last_sale_currency) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

  GET DIAGNOSTICS update_count = ROW_COUNT;
  RAISE NOTICE 'Recalculated last sale data for % ENS names with USDC last sales', update_count;
END $$;

-- Step 4: Verify the fix
DO $$
DECLARE
  bad_count INTEGER;
  sample RECORD;
BEGIN
  -- Check for any remaining USDC sales with suspiciously high USD values
  SELECT COUNT(*) INTO bad_count
  FROM ens_names
  WHERE LOWER(last_sale_currency) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    AND last_sale_price_usd > 1000000;

  RAISE NOTICE 'USDC names with last_sale_price_usd > $1M after fix: %', bad_count;

  -- Show sample of corrected USDC sales
  RAISE NOTICE '';
  RAISE NOTICE '=== Sample corrected USDC sales ===';
  FOR sample IN (
    SELECT
      en.name,
      en.last_sale_price,
      en.last_sale_price_usd,
      ROUND(CAST(en.last_sale_price AS NUMERIC) / 1e6, 2) as usdc_amount
    FROM ens_names en
    WHERE LOWER(en.last_sale_currency) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      AND en.last_sale_price_usd IS NOT NULL
    ORDER BY en.last_sale_price_usd DESC
    LIMIT 5
  ) LOOP
    RAISE NOTICE 'Name: % | USDC: $% | USD: $%',
      RPAD(sample.name, 20),
      sample.usdc_amount,
      sample.last_sale_price_usd;
  END LOOP;
END $$;
