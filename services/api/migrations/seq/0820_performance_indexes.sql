-- Performance optimization indexes (from API performance audit 2026-04-07)
-- These indexes address findings 1-6 from the audit report

-- Finding 1: Benefits names.list, votes.leaderboard, profiles.get
-- Composite index for the common pattern: JOIN listings WHERE status='active' ORDER BY created_at
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_ens_name_status_created
  ON listings(ens_name_id, status, created_at DESC);

-- Finding 3: Benefits analytics.market (name_votes time filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_name_votes_created_at
  ON name_votes(created_at DESC);

-- Finding 3: Benefits analytics.market (sales volume query with currency filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_currency_date
  ON sales(currency_address, sale_date DESC);

-- Finding 4: Benefits charts.offers, charts.listings (time-series aggregation)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_created_ens
  ON offers(created_at DESC, ens_name_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_created_ens
  ON listings(created_at DESC, ens_name_id);

-- Finding 5: Benefits activity.feed (club=any filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ens_names_has_clubs
  ON ens_names(id) WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0;

-- Finding 6: Benefits offers.by-buyer (LOWER() functional index)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_offers_buyer_lower_status_created
  ON offers(LOWER(buyer_address), status, created_at DESC);

-- Finding 6: Benefits offers.by-owner and profiles.get (LOWER() functional index)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ens_names_owner_lower
  ON ens_names(LOWER(owner_address));

-- Finding 8: Add holders_count column to clubs table (pre-computed, replaces unnest() subquery)
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS holders_count integer DEFAULT 0;

-- Backfill holders_count for all clubs
UPDATE clubs c SET holders_count = COALESCE((
  SELECT COUNT(DISTINCT owner_address)
  FROM ens_names
  WHERE owner_address IS NOT NULL
    AND expiry_date > NOW() - INTERVAL '90 days'
    AND c.name = ANY(clubs)
), 0);
