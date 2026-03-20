-- Migration: Add watchlist_lists table for multiple named watchlists
-- Each user can have up to 20 named watchlists
-- Existing watchlist entries are backfilled into a default "Watchlist" list

-- Step 1: Create the watchlist_lists table
CREATE TABLE watchlist_lists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX idx_watchlist_lists_user_id ON watchlist_lists(user_id);
CREATE INDEX idx_watchlist_lists_user_default ON watchlist_lists(user_id) WHERE is_default = TRUE;

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_watchlist_lists_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watchlist_lists_updated_at_trigger
BEFORE UPDATE ON watchlist_lists
FOR EACH ROW
EXECUTE FUNCTION update_watchlist_lists_updated_at();

-- Step 2: Add list_id column to watchlist (nullable initially for migration)
ALTER TABLE watchlist ADD COLUMN list_id INTEGER REFERENCES watchlist_lists(id) ON DELETE CASCADE;

-- Step 3: Create a default "Watchlist" list for every user who has watchlist entries
INSERT INTO watchlist_lists (user_id, name, is_default)
SELECT DISTINCT user_id, 'Watchlist', TRUE
FROM watchlist;

-- Step 4: Backfill list_id on all existing watchlist entries
UPDATE watchlist w
SET list_id = wl.id
FROM watchlist_lists wl
WHERE wl.user_id = w.user_id AND wl.is_default = TRUE;

-- Step 5: Make list_id NOT NULL now that all rows are backfilled
ALTER TABLE watchlist ALTER COLUMN list_id SET NOT NULL;

-- Step 6: Drop old unique constraint and add new one
ALTER TABLE watchlist DROP CONSTRAINT watchlist_user_id_ens_name_id_key;
ALTER TABLE watchlist ADD CONSTRAINT watchlist_list_id_ens_name_id_key UNIQUE(list_id, ens_name_id);

-- Step 7: Add indexes
CREATE INDEX idx_watchlist_list_id ON watchlist(list_id);
CREATE INDEX idx_watchlist_ens_name_id_user_id ON watchlist(ens_name_id, user_id);

-- Step 8: Recreate materialized views with COUNT(DISTINCT user_id) to handle
-- names appearing in multiple lists for the same user

DROP MATERIALIZED VIEW IF EXISTS trending_watchlist_24h CASCADE;
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
LIMIT 100;

CREATE INDEX idx_trending_watchlist_24h_count ON trending_watchlist_24h(watchlist_count_24h DESC);
CREATE UNIQUE INDEX idx_trending_watchlist_24h_id ON trending_watchlist_24h(id);

DROP MATERIALIZED VIEW IF EXISTS trending_watchlist_7d CASCADE;
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
LIMIT 100;

CREATE INDEX idx_trending_watchlist_7d_count ON trending_watchlist_7d(watchlist_count_7d DESC);
CREATE UNIQUE INDEX idx_trending_watchlist_7d_id ON trending_watchlist_7d(id);

-- Step 9: Recreate composite trending views with COUNT(DISTINCT user_id) in watchlist_counts CTE

DROP MATERIALIZED VIEW IF EXISTS trending_composite_24h CASCADE;
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
LIMIT 100;

CREATE INDEX idx_trending_composite_24h_score ON trending_composite_24h(trending_score DESC);
CREATE UNIQUE INDEX idx_trending_composite_24h_id ON trending_composite_24h(id);

DROP MATERIALIZED VIEW IF EXISTS trending_composite_7d CASCADE;
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
LIMIT 100;

CREATE INDEX idx_trending_composite_7d_score ON trending_composite_7d(trending_score DESC);
CREATE UNIQUE INDEX idx_trending_composite_7d_id ON trending_composite_7d(id);

-- Step 10: Update calculate_trending_score() to use COUNT(DISTINCT user_id)
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

  -- Watchlist adds: 5 points each (count distinct users, not entries across lists)
  SELECT COUNT(DISTINCT user_id) INTO watchlist_count
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
