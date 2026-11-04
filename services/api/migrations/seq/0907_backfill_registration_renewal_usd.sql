-- Backfill registrations.total_cost_usd and renewals.cost_usd (columns from 0906).
--
-- Plain UPDATEs, so it runs in any client (psql, pgAdmin, wrapped in a transaction or not).
-- Safe to re-run; it only touches rows still NULL. The 0906 triggers don't fire here (they
-- watch the cost/currency/date columns, not the USD ones) and these tables have no NOTIFY
-- triggers, so the WAL listener sees nothing. ETH rows dated before the first price_feeds
-- entry stay NULL; the counts at the end show how many.

UPDATE registrations
SET total_cost_usd = calculate_usd_value(
  total_cost_wei,
  COALESCE(currency_address, '0x0000000000000000000000000000000000000000'),
  eth_usd_price_at(registration_date)
)
WHERE total_cost_usd IS NULL;

UPDATE renewals
SET cost_usd = calculate_usd_value(
  cost_wei,
  COALESCE(currency_address, '0x0000000000000000000000000000000000000000'),
  eth_usd_price_at(renewal_date)
)
WHERE cost_usd IS NULL;

SELECT
  'registrations' AS table_name,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE total_cost_usd IS NULL) AS without_usd,
  MIN(registration_date) FILTER (WHERE total_cost_usd IS NOT NULL) AS first_priced
FROM registrations
UNION ALL
SELECT
  'renewals',
  COUNT(*),
  COUNT(*) FILTER (WHERE cost_usd IS NULL),
  MIN(renewal_date) FILTER (WHERE cost_usd IS NOT NULL)
FROM renewals;
