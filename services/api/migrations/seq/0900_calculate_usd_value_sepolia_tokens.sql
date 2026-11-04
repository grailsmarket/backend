-- Recognize Sepolia WETH/USDC in calculate_usd_value
-- Migration: calculate_usd_value_sepolia_tokens
-- Created: 2026-10-07
--
-- The same schema backs the mainnet and Sepolia environments. Previously only the
-- mainnet token addresses were priced; Sepolia WETH/USDC sales came back NULL.
-- Mainnet behaviour is unchanged (the Sepolia addresses never appear there).

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
    usd_value := ROUND((price_numeric / 1e18) * eth_usd_price, 2);

  ELSIF LOWER(currency_address) IN (
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', -- WETH (mainnet)
    '0xfff9976782d46cc05630d1f6ebab18b2324d6b14'  -- WETH (sepolia)
  ) THEN
    -- WETH (18 decimals) - same as ETH
    usd_value := ROUND((price_numeric / 1e18) * eth_usd_price, 2);

  ELSIF LOWER(currency_address) IN (
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', -- USDC (mainnet)
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'  -- USDC (sepolia)
  ) THEN
    -- USDC (6 decimals) - already in USD
    usd_value := ROUND((price_numeric / 1e6), 2);

  ELSE
    -- Unknown currency, return NULL
    usd_value := NULL;
  END IF;

  RETURN usd_value;
END;
$$ LANGUAGE plpgsql;
