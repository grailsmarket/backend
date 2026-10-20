-- Backfill registrations.total_cost_usd and renewals.cost_usd (columns from 0906).
--
-- Batched with a COMMIT per batch so it doesn't hold locks on the whole table: run it with
-- psql in autocommit mode (NOT inside BEGIN/COMMIT, or the COMMITs error). Safe to re-run;
-- it only touches rows still NULL. ETH rows dated before the first price_feeds entry stay
-- NULL; the counts at the end show how many.

DO $$
DECLARE
  batch_size CONSTANT INTEGER := 20000;
  cursor_id INTEGER := 0;
  max_id INTEGER;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO max_id FROM registrations;
  WHILE cursor_id < max_id LOOP
    UPDATE registrations
    SET total_cost_usd = calculate_usd_value(
      total_cost_wei,
      COALESCE(currency_address, '0x0000000000000000000000000000000000000000'),
      eth_usd_price_at(registration_date)
    )
    WHERE id > cursor_id AND id <= cursor_id + batch_size
      AND total_cost_usd IS NULL;
    COMMIT;
    cursor_id := cursor_id + batch_size;
  END LOOP;

  cursor_id := 0;
  SELECT COALESCE(MAX(id), 0) INTO max_id FROM renewals;
  WHILE cursor_id < max_id LOOP
    UPDATE renewals
    SET cost_usd = calculate_usd_value(
      cost_wei,
      COALESCE(currency_address, '0x0000000000000000000000000000000000000000'),
      eth_usd_price_at(renewal_date)
    )
    WHERE id > cursor_id AND id <= cursor_id + batch_size
      AND cost_usd IS NULL;
    COMMIT;
    cursor_id := cursor_id + batch_size;
  END LOOP;
END $$;

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
