-- USD value of every registration and renewal, at the time it happened.
--
-- v1 registrations/renewals are paid in ETH (currency_address NULL); ENSv2 ones in USDC or
-- DAI, with the *_wei columns holding that token's base units. The *_wei columns can't be
-- summed across both, so each row also gets its USD value: ETH rows at the ETH/USD price in
-- price_feeds at the registration/renewal time, stablecoin rows at face value (see
-- calculate_usd_value, 0904). A trigger fills it on insert and whenever the cost or currency
-- changes, so every writer (v1 indexer, v2 indexer, backfill scripts) gets it for free.
--
-- Rows from before price_feeds history begins stay NULL for ETH payments. Existing rows are
-- backfilled by 0907. Requires 0901 (currency_address) and 0904 (calculate_usd_value).

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC(20, 2);
ALTER TABLE renewals ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(20, 2);

COMMENT ON COLUMN registrations.total_cost_usd IS 'USD value of total_cost_wei at registration time (NULL: ETH payment before price history)';
COMMENT ON COLUMN renewals.cost_usd IS 'USD value of cost_wei at renewal time (NULL: ETH payment before price history)';

-- ETH/USD price in effect at a point in time (latest feed entry at or before it)
CREATE OR REPLACE FUNCTION eth_usd_price_at(at_time TIMESTAMPTZ)
RETURNS NUMERIC AS $$
  SELECT price FROM price_feeds
  WHERE token_symbol = 'ETH' AND quote_currency = 'USD' AND timestamp <= at_time
  ORDER BY timestamp DESC
  LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION set_registration_cost_usd()
RETURNS TRIGGER AS $$
BEGIN
  NEW.total_cost_usd := calculate_usd_value(
    NEW.total_cost_wei,
    COALESCE(NEW.currency_address, '0x0000000000000000000000000000000000000000'),
    eth_usd_price_at(NEW.registration_date)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_renewal_cost_usd()
RETURNS TRIGGER AS $$
BEGIN
  NEW.cost_usd := calculate_usd_value(
    NEW.cost_wei,
    COALESCE(NEW.currency_address, '0x0000000000000000000000000000000000000000'),
    eth_usd_price_at(NEW.renewal_date)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS registrations_cost_usd ON registrations;
CREATE TRIGGER registrations_cost_usd
  BEFORE INSERT OR UPDATE OF total_cost_wei, currency_address, registration_date ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_registration_cost_usd();

DROP TRIGGER IF EXISTS renewals_cost_usd ON renewals;
CREATE TRIGGER renewals_cost_usd
  BEFORE INSERT OR UPDATE OF cost_wei, currency_address, renewal_date ON renewals
  FOR EACH ROW EXECUTE FUNCTION set_renewal_cost_usd();

-- Club registration volume in USD, alongside the ETH (wei) volume, which now counts ETH-paid
-- registrations only. Filled by the club-stats worker.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_reg_volume_usd NUMERIC(20, 2) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_volume_usd_1y NUMERIC(20, 2) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_volume_usd_1mo NUMERIC(20, 2) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS reg_volume_usd_1w NUMERIC(20, 2) DEFAULT 0;
