-- Fix USD price storage from cents to dollars
-- Migration: fix_usd_price_cents_to_dollars
-- Created: 2025-10-28
-- Issue: last_sale_price_usd was storing cents but NUMERIC(20,2) is designed for dollars

-- Convert existing values from cents to dollars
UPDATE ens_names
SET last_sale_price_usd = last_sale_price_usd / 100.0
WHERE last_sale_price_usd IS NOT NULL;

-- Update the calculate_usd_value function to return dollars instead of cents
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

  -- Calculate USD value based on currency (return in dollars, not cents)
  IF currency_address = '0x0000000000000000000000000000000000000000' THEN
    -- Native ETH (18 decimals)
    -- Convert wei to ETH, multiply by USD price
    usd_value := ROUND((price_numeric / 1e18) * eth_usd_price, 2);

  ELSIF LOWER(currency_address) = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' THEN
    -- WETH (18 decimals) - same as ETH
    usd_value := ROUND((price_numeric / 1e18) * eth_usd_price, 2);

  ELSIF LOWER(currency_address) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' THEN
    -- USDC (6 decimals) - already in USD
    usd_value := ROUND((price_numeric / 1e6), 2);

  ELSE
    -- Unknown currency, return NULL
    usd_value := NULL;
  END IF;

  RETURN usd_value;
END;
$$ LANGUAGE plpgsql;

-- Update column comment
COMMENT ON COLUMN ens_names.last_sale_price_usd IS 'USD value of the most recent sale in dollars (e.g., 16319.19 = $16,319.19)';

-- Verify the fix
DO $$
DECLARE
  sample_record RECORD;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== Verification Sample ===';

  FOR sample_record IN (
    SELECT
      name,
      last_sale_price,
      last_sale_currency,
      last_sale_price_usd,
      CASE
        WHEN last_sale_currency = '0x0000000000000000000000000000000000000000' THEN 'ETH'
        WHEN LOWER(last_sale_currency) = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' THEN 'WETH'
        WHEN LOWER(last_sale_currency) = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' THEN 'USDC'
        ELSE 'OTHER'
      END as currency_name,
      CAST(last_sale_price AS NUMERIC) / 1e18 as eth_amount
    FROM ens_names
    WHERE last_sale_price_usd IS NOT NULL
    ORDER BY last_sale_price_usd DESC
    LIMIT 5
  ) LOOP
    RAISE NOTICE 'Name: % | Currency: % | Amount: % | USD: $%',
      RPAD(sample_record.name, 20),
      RPAD(sample_record.currency_name, 6),
      ROUND(sample_record.eth_amount, 4),
      sample_record.last_sale_price_usd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Migration completed. USD values are now in dollars (not cents).';
END $$;
