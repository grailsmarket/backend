-- Add unique indexes to materialized views for REFRESH CONCURRENTLY support
-- Migration: add_unique_indexes_materialized_views
-- Created: 2025-12-06
--
-- Problem: REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index
-- on the view. Without it, PostgreSQL throws:
-- "cannot refresh materialized view concurrently"
-- "HINT: Create a unique index with no WHERE clause on one or more columns"
--
-- Solution: Add unique indexes on the id column for each trending view

-- Trending composite 7d
CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_composite_7d_id
ON trending_composite_7d(id);

-- Trending composite 24h
CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_composite_24h_id
ON trending_composite_24h(id);

-- Trending watchlist 7d
CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_watchlist_7d_id
ON trending_watchlist_7d(id);

-- Trending watchlist 24h (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_watchlist_24h') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_watchlist_24h_id ON trending_watchlist_24h(id)';
  END IF;
END $$;

-- Trending views 7d (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_views_7d') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_views_7d_id ON trending_views_7d(id)';
  END IF;
END $$;

-- Trending views 24h (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_views_24h') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_views_24h_id ON trending_views_24h(id)';
  END IF;
END $$;

-- Trending votes 7d (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_votes_7d') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_votes_7d_id ON trending_votes_7d(id)';
  END IF;
END $$;

-- Trending votes 24h (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_votes_24h') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_votes_24h_id ON trending_votes_24h(id)';
  END IF;
END $$;

-- Trending sales 7d (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_sales_7d') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_sales_7d_id ON trending_sales_7d(id)';
  END IF;
END $$;

-- Trending sales 24h (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_sales_24h') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_sales_24h_id ON trending_sales_24h(id)';
  END IF;
END $$;

-- Trending offers 7d (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_offers_7d') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_offers_7d_id ON trending_offers_7d(id)';
  END IF;
END $$;

-- Trending offers 24h (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname = 'trending_offers_24h') THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_offers_24h_id ON trending_offers_24h(id)';
  END IF;
END $$;
