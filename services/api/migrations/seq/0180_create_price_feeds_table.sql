-- Create price_feeds table for tracking cryptocurrency prices
-- Migration: create_price_feeds_table
-- Created: 2025-10-27
-- This table stores historical price data fetched from external APIs (CoinGecko, etc.)

-- Create price_feeds table
CREATE TABLE IF NOT EXISTS price_feeds (
    id SERIAL PRIMARY KEY,

    -- Token and quote currency
    token_symbol VARCHAR(10) NOT NULL,      -- 'ETH', 'WETH', 'USDC', etc.
    quote_currency VARCHAR(10) NOT NULL,    -- 'USD'

    -- Price data
    price NUMERIC(20, 8) NOT NULL,          -- Price in quote currency (e.g., 3245.12345678)

    -- Metadata
    source VARCHAR(50) NOT NULL,            -- 'coingecko', 'chainlink', etc.
    timestamp TIMESTAMP NOT NULL,           -- When this price was valid
    created_at TIMESTAMP DEFAULT NOW(),     -- When we recorded it

    -- Prevent duplicate entries for same token/currency/timestamp
    CONSTRAINT unique_price_entry UNIQUE (token_symbol, quote_currency, timestamp)
);

-- Create indexes for efficient queries
CREATE INDEX idx_price_feeds_symbol_timestamp
    ON price_feeds(token_symbol, quote_currency, timestamp DESC);

CREATE INDEX idx_price_feeds_timestamp
    ON price_feeds(timestamp DESC);

-- Create view for easy access to latest prices
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (token_symbol, quote_currency)
    id,
    token_symbol,
    quote_currency,
    price,
    source,
    timestamp,
    created_at
FROM price_feeds
ORDER BY token_symbol, quote_currency, timestamp DESC;

-- Add comments for documentation
COMMENT ON TABLE price_feeds IS 'Historical cryptocurrency price data from external APIs';
COMMENT ON COLUMN price_feeds.token_symbol IS 'Token symbol (ETH, WETH, USDC, etc.)';
COMMENT ON COLUMN price_feeds.quote_currency IS 'Quote currency for price (typically USD)';
COMMENT ON COLUMN price_feeds.price IS 'Price in quote currency with 8 decimal precision';
COMMENT ON COLUMN price_feeds.source IS 'Data source (coingecko, chainlink, etc.)';
COMMENT ON COLUMN price_feeds.timestamp IS 'When this price was valid (not when we fetched it)';

-- Insert initial ETH price if none exists (from recent market data)
-- This ensures the system works immediately without waiting for first fetch
INSERT INTO price_feeds (token_symbol, quote_currency, price, source, timestamp)
SELECT 'ETH', 'USD', 4121.00, 'initial', NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM price_feeds WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
);

-- Verification
DO $$
DECLARE
    price_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO price_count FROM price_feeds;

    RAISE NOTICE 'Migration completed:';
    RAISE NOTICE '  - price_feeds table created';
    RAISE NOTICE '  - Indexes created';
    RAISE NOTICE '  - latest_prices view created';
    RAISE NOTICE '  - Initial prices in database: %', price_count;
END $$;
