-- Migration: Add Analytics Features
-- Description: Materialized views for trending, recommendations, and analytics
-- Author: Claude
-- Date: 2025-01-11

-- ============================================================================
-- PART 1: TRENDING MATERIALIZED VIEWS
-- ============================================================================

-- Trending by Views (24h)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_views_24h AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_views_24h_count ON trending_views_24h(view_count_24h DESC);

-- Trending by Views (7d)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_views_7d AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_views_7d_count ON trending_views_7d(view_count_7d DESC);

-- Trending by Watchlist (24h)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_watchlist_24h AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(w.id) as watchlist_count_24h,
  (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as total_watchers
FROM ens_names en
JOIN watchlist w ON w.ens_name_id = en.id
WHERE w.added_at > NOW() - INTERVAL '24 hours'
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(w.id) > 0
ORDER BY watchlist_count_24h DESC
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_watchlist_24h_count ON trending_watchlist_24h(watchlist_count_24h DESC);

-- Trending by Watchlist (7d)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_watchlist_7d AS
SELECT
  en.id,
  en.name,
  en.token_id,
  COUNT(w.id) as watchlist_count_7d,
  (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as total_watchers
FROM ens_names en
JOIN watchlist w ON w.ens_name_id = en.id
WHERE w.added_at > NOW() - INTERVAL '7 days'
GROUP BY en.id, en.name, en.token_id
HAVING COUNT(w.id) > 0
ORDER BY watchlist_count_7d DESC
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_watchlist_7d_count ON trending_watchlist_7d(watchlist_count_7d DESC);

-- Trending by Votes (24h)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_votes_24h AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_votes_24h_count ON trending_votes_24h(total_votes_24h DESC);

-- Trending by Votes (7d)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_votes_7d AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_votes_7d_count ON trending_votes_7d(total_votes_7d DESC);

-- Trending by Sales (24h)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_sales_24h AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_sales_24h_count ON trending_sales_24h(sales_count_24h DESC);
CREATE INDEX IF NOT EXISTS idx_trending_sales_24h_volume ON trending_sales_24h(total_volume_24h DESC);

-- Trending by Sales (7d)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_sales_7d AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_sales_7d_count ON trending_sales_7d(sales_count_7d DESC);
CREATE INDEX IF NOT EXISTS idx_trending_sales_7d_volume ON trending_sales_7d(total_volume_7d DESC);

-- Trending by Offers (24h)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_offers_24h AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_offers_24h_count ON trending_offers_24h(offers_count_24h DESC);

-- Trending by Offers (7d)
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_offers_7d AS
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_offers_7d_count ON trending_offers_7d(offers_count_7d DESC);

-- ============================================================================
-- PART 2: COMPOSITE TRENDING SCORE FUNCTION
-- ============================================================================

-- Calculate composite trending score for a name
-- Combines multiple signals: views, watchlist, votes, offers, listings, sales
CREATE OR REPLACE FUNCTION calculate_trending_score(
  name_id INTEGER,
  time_period INTERVAL DEFAULT INTERVAL '24 hours'
)
RETURNS NUMERIC AS $$
DECLARE
  score NUMERIC := 0;
  view_count INTEGER;
  watchlist_count INTEGER;
  upvote_count INTEGER;
  downvote_count INTEGER;
  offer_count INTEGER;
  listing_count INTEGER;
  sale_count INTEGER;
BEGIN
  -- Views: 1 point each
  SELECT COUNT(*) INTO view_count
  FROM public.name_views
  WHERE ens_name_id = name_id
    AND viewed_at > NOW() - time_period;
  score := score + (view_count * 1);

  -- Watchlist adds: 5 points each
  SELECT COUNT(*) INTO watchlist_count
  FROM public.watchlist
  WHERE ens_name_id = name_id
    AND added_at > NOW() - time_period;
  score := score + (watchlist_count * 5);

  -- Upvotes: 3 points each, Downvotes: -1 point each
  SELECT
    COUNT(*) FILTER (WHERE vote = 1),
    COUNT(*) FILTER (WHERE vote = -1)
  INTO upvote_count, downvote_count
  FROM public.name_votes
  WHERE ens_name_id = name_id
    AND created_at > NOW() - time_period;
  score := score + (upvote_count * 3) + (downvote_count * -1);

  -- Offers: 10 points each
  SELECT COUNT(*) INTO offer_count
  FROM public.offers
  WHERE ens_name_id = name_id
    AND created_at > NOW() - time_period
    AND status IN ('pending', 'active')
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  score := score + (offer_count * 10);

  -- Listings: 8 points each
  SELECT COUNT(*) INTO listing_count
  FROM public.listings
  WHERE ens_name_id = name_id
    AND created_at > NOW() - time_period
    AND status = 'active'
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  score := score + (listing_count * 8);

  -- Sales: 50 points each (strongest signal)
  SELECT COUNT(*) INTO sale_count
  FROM public.sales
  WHERE ens_name_id = name_id
    AND sale_date > NOW() - time_period
    AND (currency_address = '0x0000000000000000000000000000000000000000'
         OR currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  score := score + (sale_count * 50);

  RETURN score;
END;
$$ LANGUAGE plpgsql;

-- Composite trending view (24h)
-- Optimized: only processes names with recent activity, calculates score inline
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_composite_24h AS
WITH recent_activity AS (
  -- Find all names with any activity in last 24h
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
  SELECT ens_name_id, COUNT(*) as count
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
  -- Calculate composite score inline
  (COALESCE(v.count, 0) * 1 +
   COALESCE(w.count, 0) * 5 +
   COALESCE(vt.upvotes, 0) * 3 +
   COALESCE(vt.downvotes, 0) * -1 +
   COALESCE(o.count, 0) * 10 +
   COALESCE(l.count, 0) * 8 +
   COALESCE(s.count, 0) * 50) as trending_score,
  -- Include individual signals for display
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_composite_24h_score ON trending_composite_24h(trending_score DESC);

-- Composite trending view (7d)
-- Optimized: only processes names with recent activity, calculates score inline
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_composite_7d AS
WITH recent_activity AS (
  -- Find all names with any activity in last 7 days
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
  SELECT ens_name_id, COUNT(*) as count
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
  -- Calculate composite score inline
  (COALESCE(v.count, 0) * 1 +
   COALESCE(w.count, 0) * 5 +
   COALESCE(vt.upvotes, 0) * 3 +
   COALESCE(vt.downvotes, 0) * -1 +
   COALESCE(o.count, 0) * 10 +
   COALESCE(l.count, 0) * 8 +
   COALESCE(s.count, 0) * 50) as trending_score,
  -- Include individual signals for display
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
LIMIT 100;

CREATE INDEX IF NOT EXISTS idx_trending_composite_7d_score ON trending_composite_7d(trending_score DESC);

-- ============================================================================
-- PART 3: HELPER FUNCTIONS FOR ANALYTICS
-- ============================================================================

-- Get collectors who also viewed a specific name
CREATE OR REPLACE FUNCTION get_collectors_also_viewed(
  target_name_id INTEGER,
  result_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  ens_name_id INTEGER,
  name VARCHAR,
  also_viewed_count BIGINT,
  shared_viewers INTEGER[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    nv2.ens_name_id,
    en.name,
    COUNT(DISTINCT nv2.viewer_identifier) as also_viewed_count,
    ARRAY_AGG(DISTINCT nv2.viewer_identifier::INTEGER ORDER BY nv2.viewer_identifier::INTEGER) as shared_viewers
  FROM public.name_views nv1
  JOIN public.name_views nv2 ON nv1.viewer_identifier = nv2.viewer_identifier
  JOIN public.ens_names en ON nv2.ens_name_id = en.id
  WHERE nv1.ens_name_id = target_name_id
    AND nv2.ens_name_id != target_name_id
    AND nv1.viewer_type = 'authenticated'
    AND nv2.viewer_type = 'authenticated'
  GROUP BY nv2.ens_name_id, en.name
  ORDER BY also_viewed_count DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Get names similar to user's watchlist
CREATE OR REPLACE FUNCTION get_similar_to_watchlist(
  target_user_id INTEGER,
  result_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  ens_name_id INTEGER,
  name VARCHAR,
  similarity_score BIGINT,
  common_watchers INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w2.ens_name_id,
    en.name,
    COUNT(DISTINCT w2.user_id) as similarity_score,
    COUNT(DISTINCT w2.user_id)::INTEGER as common_watchers
  FROM public.watchlist w1
  JOIN public.watchlist w2 ON w1.ens_name_id = w2.ens_name_id
  JOIN public.ens_names en ON w2.ens_name_id = en.id
  WHERE w1.user_id = target_user_id
    AND w2.user_id != target_user_id
    AND w2.ens_name_id NOT IN (
      SELECT ens_name_id FROM public.watchlist WHERE user_id = target_user_id
    )
  GROUP BY w2.ens_name_id, en.name
  ORDER BY similarity_score DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Get recommendations based on user's votes
CREATE OR REPLACE FUNCTION get_recommendations_by_votes(
  target_user_id INTEGER,
  result_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  ens_name_id INTEGER,
  name VARCHAR,
  recommendation_score BIGINT,
  similar_voters INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    nv2.ens_name_id,
    en.name,
    COUNT(DISTINCT nv2.user_id) as recommendation_score,
    COUNT(DISTINCT nv2.user_id)::INTEGER as similar_voters
  FROM public.name_votes nv1
  JOIN public.name_votes nv2 ON nv1.ens_name_id = nv2.ens_name_id
  JOIN public.ens_names en ON nv2.ens_name_id = en.id
  WHERE nv1.user_id = target_user_id
    AND nv2.user_id != target_user_id
    AND nv1.vote = 1  -- Only consider upvotes
    AND nv2.vote = 1
    AND nv2.ens_name_id NOT IN (
      SELECT ens_name_id FROM public.name_votes WHERE user_id = target_user_id
    )
  GROUP BY nv2.ens_name_id, en.name
  ORDER BY recommendation_score DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 4: COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON MATERIALIZED VIEW trending_views_24h IS 'Top 100 names by view count in the last 24 hours';
COMMENT ON MATERIALIZED VIEW trending_views_7d IS 'Top 100 names by view count in the last 7 days';
COMMENT ON MATERIALIZED VIEW trending_watchlist_24h IS 'Top 100 names by watchlist additions in the last 24 hours';
COMMENT ON MATERIALIZED VIEW trending_watchlist_7d IS 'Top 100 names by watchlist additions in the last 7 days';
COMMENT ON MATERIALIZED VIEW trending_votes_24h IS 'Top 100 names by vote activity in the last 24 hours';
COMMENT ON MATERIALIZED VIEW trending_votes_7d IS 'Top 100 names by vote activity in the last 7 days';
COMMENT ON MATERIALIZED VIEW trending_sales_24h IS 'Top 100 names by sales activity in the last 24 hours (ETH/WETH only)';
COMMENT ON MATERIALIZED VIEW trending_sales_7d IS 'Top 100 names by sales activity in the last 7 days (ETH/WETH only)';
COMMENT ON MATERIALIZED VIEW trending_offers_24h IS 'Top 100 names by offer activity in the last 24 hours (ETH/WETH only)';
COMMENT ON MATERIALIZED VIEW trending_offers_7d IS 'Top 100 names by offer activity in the last 7 days (ETH/WETH only)';
COMMENT ON MATERIALIZED VIEW trending_composite_24h IS 'Top 100 names by composite trending score in the last 24 hours';
COMMENT ON MATERIALIZED VIEW trending_composite_7d IS 'Top 100 names by composite trending score in the last 7 days';

COMMENT ON FUNCTION calculate_trending_score IS 'Calculate composite trending score combining views (1pt), watchlist (5pt), upvotes (3pt), downvotes (-1pt), offers (10pt), listings (8pt), sales (50pt)';
COMMENT ON FUNCTION get_collectors_also_viewed IS 'Get names that authenticated users who viewed a specific name also viewed (collaborative filtering)';
COMMENT ON FUNCTION get_similar_to_watchlist IS 'Get names watched by users with similar watchlists (collaborative filtering)';
COMMENT ON FUNCTION get_recommendations_by_votes IS 'Get names upvoted by users with similar voting patterns (collaborative filtering)';
