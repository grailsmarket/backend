-- ens_names.name: VARCHAR(255) -> TEXT (and ai_recommendations.name, which caches per name)
--
-- ENSv2 labels go up to 255 bytes, so a .eth name can be 259 characters. The first one
-- (block 26440220, tx 0x02d6...cb16, label "x" x 255) failed the ENSv2 indexer's INSERT
-- with 22001 and has frozen the v2 cursor at 26440219 since 2026-11-18 06:42 UTC. v1 never
-- had a length limit either. Once this commits, the indexer's next retry processes that
-- block and catches up on its own; no replay is needed (nothing was skipped).
--
-- COST (measured read-only on prod 2026-11-18, 3.56M rows, 1.4 GB heap):
--   No table rewrite (varchar -> text is binary-compatible), but Postgres rebuilds the two
--   indexes on name that have an expression or predicate, idx_ens_names_name_lower (215 MB)
--   and ens_names_real_name_unique (138 MB), while holding ACCESS EXCLUSIVE on ens_names.
--   The heap scan is ~2 s; the sort dominates: en_US.utf8 (glibc) comparisons make it ~3 min
--   per index single-process. With 4 parallel maintenance workers expect roughly 1-3 min in
--   total. Everything that touches ens_names (API, indexers, stream, workers) waits until
--   COMMIT, and the postgres role's 2 min statement_timeout applies to those waiters.
--   Run in a low-traffic window.
--
-- The 12 trending_* materialized views select en.name, which blocks ALTER TYPE, so they are
-- dropped and recreated WITH NO DATA so their queries (trending_views_* ~11 s each) stay out of
-- the lock window. Part 2 populates them after COMMIT; trending endpoints error ("has not been
-- populated") for those ~30 s. Avoid :00/:15/:30/:45, when refresh-analytics runs.
--
-- View SQL is copied verbatim from the migrations that created them (0240; 0770 for
-- trending_composite_* and trending_watchlist_*). Verified 2026-11-19 against prod: each
-- produces a stored query tree identical to prod's live view (pg_rewrite, compared on PG 17.11
-- with prod's exact table layouts; only the per-table column snapshots, which predate columns
-- added since, were excluded). pg_get_viewdef output was NOT used: re-parsing it changes the
-- stored tree for 6 of the views (implicit casts become explicit, an IN list's array cast moves).
-- Indexes and comments are prod's pg_get_indexdef / obj_description, byte-identical.
--
-- RUN WITH psql -f (not a client that wraps the file in one transaction, which would hold
-- the ens_names lock through part 2). If it fails on lock_timeout, a long query was holding
-- ens_names or a matview: nothing changed, rerun. If a parallel worker fails to get shared
-- memory (/dev/shm), nothing changed either: rerun with max_parallel_maintenance_workers = 0.

-- ---------------------------------------------------------------------------------------
-- Part 1: one transaction
-- ---------------------------------------------------------------------------------------
BEGIN;

SET LOCAL lock_timeout = '5s';            -- fail fast instead of queueing: a waiting ACCESS
                                          -- EXCLUSIVE request blocks every later reader too
SET LOCAL statement_timeout = '15min';    -- role default is 2min; the index rebuilds need longer
SET LOCAL maintenance_work_mem = '256MB'; -- default 64MB; split across the parallel workers
SET LOCAL max_parallel_maintenance_workers = 4;  -- default 2 (max_parallel_workers = 8)

DROP MATERIALIZED VIEW trending_composite_24h;
DROP MATERIALIZED VIEW trending_composite_7d;
DROP MATERIALIZED VIEW trending_offers_24h;
DROP MATERIALIZED VIEW trending_offers_7d;
DROP MATERIALIZED VIEW trending_sales_24h;
DROP MATERIALIZED VIEW trending_sales_7d;
DROP MATERIALIZED VIEW trending_views_24h;
DROP MATERIALIZED VIEW trending_views_7d;
DROP MATERIALIZED VIEW trending_votes_24h;
DROP MATERIALIZED VIEW trending_votes_7d;
DROP MATERIALIZED VIEW trending_watchlist_24h;
DROP MATERIALIZED VIEW trending_watchlist_7d;

ALTER TABLE ens_names ALTER COLUMN name TYPE text;
-- Its only index on name is a plain unique btree (unique_ai_recommendation_name), which Postgres
-- keeps as is (no rebuild); 3 rows.
ALTER TABLE ai_recommendations ALTER COLUMN name TYPE text;

CREATE MATERIALIZED VIEW trending_composite_24h AS
WITH recent_activity AS (
  SELECT DISTINCT ens_name_id FROM (
    SELECT ens_name_id FROM public.name_views WHERE viewed_at > NOW() - INTERVAL '24 hours'
    UNION
    SELECT ens_name_id FROM public.watchlist WHERE added_at > NOW() - INTERVAL '24 hours'
    UNION
    SELECT ens_name_id FROM public.name_votes WHERE created_at > NOW() - INTERVAL '24 hours'
    UNION
    SELECT ens_name_id FROM public.offers WHERE created_at > NOW() - INTERVAL '24 hours'
    UNION
    SELECT ens_name_id FROM public.listings WHERE created_at > NOW() - INTERVAL '24 hours'
    UNION
    SELECT ens_name_id FROM public.sales WHERE sale_date > NOW() - INTERVAL '24 hours'
  ) active
),
view_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.name_views
  WHERE viewed_at > NOW() - INTERVAL '24 hours'
  GROUP BY ens_name_id
),
watchlist_counts AS (
  SELECT ens_name_id, COUNT(DISTINCT user_id) as count
  FROM public.watchlist
  WHERE added_at > NOW() - INTERVAL '24 hours'
  GROUP BY ens_name_id
),
vote_counts AS (
  SELECT ens_name_id,
    COUNT(*) FILTER (WHERE vote = 1) as upvotes,
    COUNT(*) FILTER (WHERE vote = -1) as downvotes,
    COUNT(*) as total
  FROM public.name_votes
  WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY ens_name_id
),
offer_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.offers
  WHERE created_at > NOW() - INTERVAL '24 hours'
    AND status IN ('pending', 'active')
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  GROUP BY ens_name_id
),
listing_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.listings
  WHERE created_at > NOW() - INTERVAL '24 hours'
    AND status = 'active'
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  GROUP BY ens_name_id
),
sale_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.sales
  WHERE sale_date > NOW() - INTERVAL '24 hours'
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  GROUP BY ens_name_id
)
SELECT
  en.id,
  en.name,
  en.token_id,
  (COALESCE(v.count, 0) * 1 +
   COALESCE(w.count, 0) * 5 +
   COALESCE(vt.upvotes, 0) * 3 +
   COALESCE(vt.downvotes, 0) * -1 +
   COALESCE(o.count, 0) * 10 +
   COALESCE(l.count, 0) * 8 +
   COALESCE(s.count, 0) * 50) as trending_score,
  COALESCE(v.count, 0) as views_24h,
  COALESCE(w.count, 0) as watchlist_adds_24h,
  COALESCE(vt.total, 0) as votes_24h,
  COALESCE(o.count, 0) as offers_24h,
  COALESCE(s.count, 0) as sales_24h
FROM public.ens_names en
JOIN recent_activity ra ON ra.ens_name_id = en.id
LEFT JOIN view_counts v ON v.ens_name_id = en.id
LEFT JOIN watchlist_counts w ON w.ens_name_id = en.id
LEFT JOIN vote_counts vt ON vt.ens_name_id = en.id
LEFT JOIN offer_counts o ON o.ens_name_id = en.id
LEFT JOIN listing_counts l ON l.ens_name_id = en.id
LEFT JOIN sale_counts s ON s.ens_name_id = en.id
WHERE (COALESCE(v.count, 0) * 1 +
       COALESCE(w.count, 0) * 5 +
       COALESCE(vt.upvotes, 0) * 3 +
       COALESCE(vt.downvotes, 0) * -1 +
       COALESCE(o.count, 0) * 10 +
       COALESCE(l.count, 0) * 8 +
       COALESCE(s.count, 0) * 50) > 0
ORDER BY trending_score DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_composite_24h_id ON public.trending_composite_24h USING btree (id);
CREATE INDEX idx_trending_composite_24h_score ON public.trending_composite_24h USING btree (trending_score DESC);

CREATE MATERIALIZED VIEW trending_composite_7d AS
WITH recent_activity AS (
  SELECT DISTINCT ens_name_id FROM (
    SELECT ens_name_id FROM public.name_views WHERE viewed_at > NOW() - INTERVAL '7 days'
    UNION
    SELECT ens_name_id FROM public.watchlist WHERE added_at > NOW() - INTERVAL '7 days'
    UNION
    SELECT ens_name_id FROM public.name_votes WHERE created_at > NOW() - INTERVAL '7 days'
    UNION
    SELECT ens_name_id FROM public.offers WHERE created_at > NOW() - INTERVAL '7 days'
    UNION
    SELECT ens_name_id FROM public.listings WHERE created_at > NOW() - INTERVAL '7 days'
    UNION
    SELECT ens_name_id FROM public.sales WHERE sale_date > NOW() - INTERVAL '7 days'
  ) active
),
view_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.name_views
  WHERE viewed_at > NOW() - INTERVAL '7 days'
  GROUP BY ens_name_id
),
watchlist_counts AS (
  SELECT ens_name_id, COUNT(DISTINCT user_id) as count
  FROM public.watchlist
  WHERE added_at > NOW() - INTERVAL '7 days'
  GROUP BY ens_name_id
),
vote_counts AS (
  SELECT ens_name_id,
    COUNT(*) FILTER (WHERE vote = 1) as upvotes,
    COUNT(*) FILTER (WHERE vote = -1) as downvotes,
    COUNT(*) as total
  FROM public.name_votes
  WHERE created_at > NOW() - INTERVAL '7 days'
  GROUP BY ens_name_id
),
offer_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.offers
  WHERE created_at > NOW() - INTERVAL '7 days'
    AND status IN ('pending', 'active')
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  GROUP BY ens_name_id
),
listing_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.listings
  WHERE created_at > NOW() - INTERVAL '7 days'
    AND status = 'active'
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  GROUP BY ens_name_id
),
sale_counts AS (
  SELECT ens_name_id, COUNT(*) as count
  FROM public.sales
  WHERE sale_date > NOW() - INTERVAL '7 days'
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  GROUP BY ens_name_id
)
SELECT
  en.id,
  en.name,
  en.token_id,
  (COALESCE(v.count, 0) * 1 +
   COALESCE(w.count, 0) * 5 +
   COALESCE(vt.upvotes, 0) * 3 +
   COALESCE(vt.downvotes, 0) * -1 +
   COALESCE(o.count, 0) * 10 +
   COALESCE(l.count, 0) * 8 +
   COALESCE(s.count, 0) * 50) as trending_score,
  COALESCE(v.count, 0) as views_7d,
  COALESCE(w.count, 0) as watchlist_adds_7d,
  COALESCE(vt.total, 0) as votes_7d,
  COALESCE(o.count, 0) as offers_7d,
  COALESCE(s.count, 0) as sales_7d
FROM public.ens_names en
JOIN recent_activity ra ON ra.ens_name_id = en.id
LEFT JOIN view_counts v ON v.ens_name_id = en.id
LEFT JOIN watchlist_counts w ON w.ens_name_id = en.id
LEFT JOIN vote_counts vt ON vt.ens_name_id = en.id
LEFT JOIN offer_counts o ON o.ens_name_id = en.id
LEFT JOIN listing_counts l ON l.ens_name_id = en.id
LEFT JOIN sale_counts s ON s.ens_name_id = en.id
WHERE (COALESCE(v.count, 0) * 1 +
       COALESCE(w.count, 0) * 5 +
       COALESCE(vt.upvotes, 0) * 3 +
       COALESCE(vt.downvotes, 0) * -1 +
       COALESCE(o.count, 0) * 10 +
       COALESCE(l.count, 0) * 8 +
       COALESCE(s.count, 0) * 50) > 0
ORDER BY trending_score DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_composite_7d_id ON public.trending_composite_7d USING btree (id);
CREATE INDEX idx_trending_composite_7d_score ON public.trending_composite_7d USING btree (trending_score DESC);

CREATE MATERIALIZED VIEW trending_offers_24h AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(o.id) as offers_count_24h,
  MAX(o.offer_amount_wei::numeric) as highest_offer_24h,
  AVG(o.offer_amount_wei::numeric) as avg_offer_24h,
  COUNT(DISTINCT o.buyer_address) as unique_bidders_24h
FROM ens_names en
JOIN offers o ON o.ens_name_id = en.id
WHERE o.created_at > NOW() - INTERVAL '24 hours'
  AND o.status IN ('pending', 'active')
  AND (o.currency_address = '0x0000000000000000000000000000000000000000'
       OR o.currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(o.id) > 0
ORDER BY offers_count_24h DESC, highest_offer_24h DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_offers_24h_id ON public.trending_offers_24h USING btree (id);
CREATE INDEX idx_trending_offers_24h_count ON public.trending_offers_24h USING btree (offers_count_24h DESC);
COMMENT ON MATERIALIZED VIEW trending_offers_24h IS 'Top 100 names by offer activity in the last 24 hours (ETH/WETH only)';

CREATE MATERIALIZED VIEW trending_offers_7d AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(o.id) as offers_count_7d,
  MAX(o.offer_amount_wei::numeric) as highest_offer_7d,
  AVG(o.offer_amount_wei::numeric) as avg_offer_7d,
  COUNT(DISTINCT o.buyer_address) as unique_bidders_7d
FROM ens_names en
JOIN offers o ON o.ens_name_id = en.id
WHERE o.created_at > NOW() - INTERVAL '7 days'
  AND o.status IN ('pending', 'active')
  AND (o.currency_address = '0x0000000000000000000000000000000000000000'
       OR o.currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(o.id) > 0
ORDER BY offers_count_7d DESC, highest_offer_7d DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_offers_7d_id ON public.trending_offers_7d USING btree (id);
CREATE INDEX idx_trending_offers_7d_count ON public.trending_offers_7d USING btree (offers_count_7d DESC);
COMMENT ON MATERIALIZED VIEW trending_offers_7d IS 'Top 100 names by offer activity in the last 7 days (ETH/WETH only)';

CREATE MATERIALIZED VIEW trending_sales_24h AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(s.id) as sales_count_24h,
  SUM(s.sale_price_wei::numeric) as total_volume_24h,
  AVG(s.sale_price_wei::numeric) as avg_price_24h,
  MAX(s.sale_price_wei::numeric) as max_price_24h,
  MIN(s.sale_price_wei::numeric) as min_price_24h
FROM ens_names en
JOIN sales s ON s.ens_name_id = en.id
WHERE s.sale_date > NOW() - INTERVAL '24 hours'
  AND (s.currency_address = '0x0000000000000000000000000000000000000000'
       OR s.currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(s.id) > 0
ORDER BY sales_count_24h DESC, total_volume_24h DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_sales_24h_id ON public.trending_sales_24h USING btree (id);
CREATE INDEX idx_trending_sales_24h_count ON public.trending_sales_24h USING btree (sales_count_24h DESC);
CREATE INDEX idx_trending_sales_24h_volume ON public.trending_sales_24h USING btree (total_volume_24h DESC);
COMMENT ON MATERIALIZED VIEW trending_sales_24h IS 'Top 100 names by sales activity in the last 24 hours (ETH/WETH only)';

CREATE MATERIALIZED VIEW trending_sales_7d AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(s.id) as sales_count_7d,
  SUM(s.sale_price_wei::numeric) as total_volume_7d,
  AVG(s.sale_price_wei::numeric) as avg_price_7d,
  MAX(s.sale_price_wei::numeric) as max_price_7d,
  MIN(s.sale_price_wei::numeric) as min_price_7d
FROM ens_names en
JOIN sales s ON s.ens_name_id = en.id
WHERE s.sale_date > NOW() - INTERVAL '7 days'
  AND (s.currency_address = '0x0000000000000000000000000000000000000000'
       OR s.currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(s.id) > 0
ORDER BY sales_count_7d DESC, total_volume_7d DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_sales_7d_id ON public.trending_sales_7d USING btree (id);
CREATE INDEX idx_trending_sales_7d_count ON public.trending_sales_7d USING btree (sales_count_7d DESC);
CREATE INDEX idx_trending_sales_7d_volume ON public.trending_sales_7d USING btree (total_volume_7d DESC);
COMMENT ON MATERIALIZED VIEW trending_sales_7d IS 'Top 100 names by sales activity in the last 7 days (ETH/WETH only)';

CREATE MATERIALIZED VIEW trending_views_24h AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(nv.id) as view_count_24h,
  COUNT(DISTINCT nv.viewer_identifier) as unique_viewers_24h,
  en.view_count as total_views
FROM ens_names en
LEFT JOIN name_views nv ON nv.ens_name_id = en.id
  AND nv.viewed_at > NOW() - INTERVAL '24 hours'
WHERE en.view_count > 0 OR nv.id IS NOT NULL
GROUP BY en.id, en.name, en.token_id, en.view_count
HAVING COUNT(nv.id) > 0
ORDER BY view_count_24h DESC, unique_viewers_24h DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_views_24h_id ON public.trending_views_24h USING btree (id);
CREATE INDEX idx_trending_views_24h_count ON public.trending_views_24h USING btree (view_count_24h DESC);
COMMENT ON MATERIALIZED VIEW trending_views_24h IS 'Top 100 names by view count in the last 24 hours';

CREATE MATERIALIZED VIEW trending_views_7d AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(nv.id) as view_count_7d,
  COUNT(DISTINCT nv.viewer_identifier) as unique_viewers_7d,
  en.view_count as total_views
FROM ens_names en
LEFT JOIN name_views nv ON nv.ens_name_id = en.id
  AND nv.viewed_at > NOW() - INTERVAL '7 days'
WHERE en.view_count > 0 OR nv.id IS NOT NULL
GROUP BY en.id, en.name, en.token_id, en.view_count
HAVING COUNT(nv.id) > 0
ORDER BY view_count_7d DESC, unique_viewers_7d DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_views_7d_id ON public.trending_views_7d USING btree (id);
CREATE INDEX idx_trending_views_7d_count ON public.trending_views_7d USING btree (view_count_7d DESC);
COMMENT ON MATERIALIZED VIEW trending_views_7d IS 'Top 100 names by view count in the last 7 days';

CREATE MATERIALIZED VIEW trending_votes_24h AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(nv.id) FILTER (WHERE nv.vote = 1) as upvotes_24h,
  COUNT(nv.id) FILTER (WHERE nv.vote = -1) as downvotes_24h,
  COUNT(nv.id) as total_votes_24h,
  COALESCE(en.net_score, 0) as net_score_total
FROM ens_names en
JOIN name_votes nv ON nv.ens_name_id = en.id
WHERE nv.created_at > NOW() - INTERVAL '24 hours'
GROUP BY en.id, en.name, en.token_id, en.net_score
HAVING COUNT(nv.id) > 0
ORDER BY total_votes_24h DESC, upvotes_24h DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_votes_24h_id ON public.trending_votes_24h USING btree (id);
CREATE INDEX idx_trending_votes_24h_count ON public.trending_votes_24h USING btree (total_votes_24h DESC);
COMMENT ON MATERIALIZED VIEW trending_votes_24h IS 'Top 100 names by vote activity in the last 24 hours';

CREATE MATERIALIZED VIEW trending_votes_7d AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(nv.id) FILTER (WHERE nv.vote = 1) as upvotes_7d,
  COUNT(nv.id) FILTER (WHERE nv.vote = -1) as downvotes_7d,
  COUNT(nv.id) as total_votes_7d,
  COALESCE(en.net_score, 0) as net_score_total
FROM ens_names en
JOIN name_votes nv ON nv.ens_name_id = en.id
WHERE nv.created_at > NOW() - INTERVAL '7 days'
GROUP BY en.id, en.name, en.token_id, en.net_score
HAVING COUNT(nv.id) > 0
ORDER BY total_votes_7d DESC, upvotes_7d DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_votes_7d_id ON public.trending_votes_7d USING btree (id);
CREATE INDEX idx_trending_votes_7d_count ON public.trending_votes_7d USING btree (total_votes_7d DESC);
COMMENT ON MATERIALIZED VIEW trending_votes_7d IS 'Top 100 names by vote activity in the last 7 days';

CREATE MATERIALIZED VIEW trending_watchlist_24h AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(DISTINCT w.user_id) as watchlist_count_24h,
  (SELECT COUNT(DISTINCT user_id) FROM watchlist WHERE ens_name_id = en.id) as total_watchers
FROM ens_names en
JOIN watchlist w ON w.ens_name_id = en.id
WHERE w.added_at > NOW() - INTERVAL '24 hours'
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(DISTINCT w.user_id) > 0
ORDER BY watchlist_count_24h DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_watchlist_24h_id ON public.trending_watchlist_24h USING btree (id);
CREATE INDEX idx_trending_watchlist_24h_count ON public.trending_watchlist_24h USING btree (watchlist_count_24h DESC);

CREATE MATERIALIZED VIEW trending_watchlist_7d AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(DISTINCT w.user_id) as watchlist_count_7d,
  (SELECT COUNT(DISTINCT user_id) FROM watchlist WHERE ens_name_id = en.id) as total_watchers
FROM ens_names en
JOIN watchlist w ON w.ens_name_id = en.id
WHERE w.added_at > NOW() - INTERVAL '7 days'
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(DISTINCT w.user_id) > 0
ORDER BY watchlist_count_7d DESC
LIMIT 100
WITH NO DATA;
CREATE UNIQUE INDEX idx_trending_watchlist_7d_id ON public.trending_watchlist_7d USING btree (id);
CREATE INDEX idx_trending_watchlist_7d_count ON public.trending_watchlist_7d USING btree (watchlist_count_7d DESC);

COMMIT;

-- ---------------------------------------------------------------------------------------
-- Part 2: populate the trending views (each locks only its own view; must be a plain
-- REFRESH, since CONCURRENTLY needs an already-populated view)
-- ---------------------------------------------------------------------------------------
REFRESH MATERIALIZED VIEW trending_composite_24h;
REFRESH MATERIALIZED VIEW trending_composite_7d;
REFRESH MATERIALIZED VIEW trending_offers_24h;
REFRESH MATERIALIZED VIEW trending_offers_7d;
REFRESH MATERIALIZED VIEW trending_sales_24h;
REFRESH MATERIALIZED VIEW trending_sales_7d;
REFRESH MATERIALIZED VIEW trending_views_24h;
REFRESH MATERIALIZED VIEW trending_views_7d;
REFRESH MATERIALIZED VIEW trending_votes_24h;
REFRESH MATERIALIZED VIEW trending_votes_7d;
REFRESH MATERIALIZED VIEW trending_watchlist_24h;
REFRESH MATERIALIZED VIEW trending_watchlist_7d;
