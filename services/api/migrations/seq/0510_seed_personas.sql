-- Migration: 0510_seed_personas
-- Description: Seed all 8 persona rows with criteria and default filter presets
-- Filter keys conform to the SearchFilters interface in services/sdk/src/types/filters.ts

INSERT INTO personas (slug, name, description, icon, priority, criteria, default_filters_all_names, default_filters_listings, default_filters_sales, default_filters_registrations, default_filters_offers, is_default)
VALUES
  (
    'whale',
    'Whale',
    'Owns a large portfolio of ENS names, focused on portfolio management and high-value assets.',
    'whale',
    100,
    '{"min_names": 200}',
    '{"sortBy": "expiry_date", "sortOrder": "asc", "status": "registered"}',
    '{"sortBy": "price", "sortOrder": "desc"}',
    '{"sortBy": "last_sale_price", "sortOrder": "desc"}',
    '{"sortBy": "registration_date", "sortOrder": "desc"}',
    '{"sortBy": "offer", "sortOrder": "desc"}',
    FALSE
  ),
  (
    'og',
    'OG',
    'An early ENS adopter with names registered before the mainstream wave.',
    'crown',
    95,
    '{"max_avg_registration_year": 2019, "in_legends": true}',
    '{"sortBy": "registration_date", "sortOrder": "asc"}',
    '{"sortBy": "registration_date", "sortOrder": "asc"}',
    '{"sortBy": "last_sale_date", "sortOrder": "asc"}',
    '{"sortBy": "registration_date", "sortOrder": "asc"}',
    '{"sortBy": "registration_date", "sortOrder": "asc"}',
    FALSE
  ),
  (
    'digits',
    'Digit Collector',
    'Specializes in collecting numeric ENS names.',
    'hash',
    90,
    '{"min_digit_ratio": 0.5, "min_names": 5}',
    '{"digits": "only", "sortBy": "character_count", "sortOrder": "asc"}',
    '{"digits": "only", "sortBy": "character_count", "sortOrder": "asc"}',
    '{"digits": "only", "sortBy": "last_sale_price", "sortOrder": "desc"}',
    '{"digits": "only", "sortBy": "registration_date", "sortOrder": "desc"}',
    '{"digits": "only", "sortBy": "offer", "sortOrder": "desc"}',
    FALSE
  ),
  (
    'trader',
    'Trader',
    'Actively buys and sells ENS names, focused on deal-finding and market activity.',
    'chart',
    85,
    '{"min_trades": 10, "min_trades_per_month": 2}',
    '{"listed": true, "sortBy": "price", "sortOrder": "asc"}',
    '{"sortBy": "price", "sortOrder": "asc"}',
    '{"sortBy": "last_sale_date", "sortOrder": "desc"}',
    '{"sortBy": "registration_date", "sortOrder": "desc"}',
    '{"sortBy": "offer", "sortOrder": "desc"}',
    FALSE
  ),
  (
    'lifer',
    'Lifer',
    'Holds ENS names with long-term registrations, showcasing commitment and longevity.',
    'shield',
    80,
    '{"min_avg_years_remaining": 8, "min_names": 3}',
    '{"sortBy": "expiry_date", "sortOrder": "desc"}',
    '{"sortBy": "expiry_date", "sortOrder": "desc"}',
    '{"sortBy": "last_sale_price", "sortOrder": "desc"}',
    '{"sortBy": "registration_date", "sortOrder": "asc"}',
    '{"sortBy": "expiry_date", "sortOrder": "desc"}',
    FALSE
  ),
  (
    'clubber',
    'Clubber',
    'Collects names that belong to ENS clubs like 999, 10k, and 100k.',
    'sparkles',
    75,
    '{"min_club_ratio": 0.5, "min_names": 5}',
    '{"inAnyClub": true, "sortBy": "clubs_count", "sortOrder": "desc"}',
    '{"inAnyClub": true, "sortBy": "price", "sortOrder": "asc"}',
    '{"sortBy": "last_sale_price", "sortOrder": "desc"}',
    '{"sortBy": "registration_date", "sortOrder": "desc"}',
    '{"inAnyClub": true, "sortBy": "offer", "sortOrder": "desc"}',
    FALSE
  ),
  (
    'id',
    'Identity',
    'Uses a single ENS name as their primary digital identity.',
    'user',
    70,
    '{"exact_names": 1}',
    '{"sortBy": "watchers_count", "sortOrder": "desc"}',
    '{"sortBy": "price", "sortOrder": "asc"}',
    '{"sortBy": "last_sale_price", "sortOrder": "desc"}',
    '{"sortBy": "registration_date", "sortOrder": "desc"}',
    '{"sortBy": "offer", "sortOrder": "desc"}',
    FALSE
  ),
  (
    'general',
    'Explorer',
    'A general marketplace participant exploring the ENS ecosystem.',
    'compass',
    0,
    '{}',
    '{}',
    '{}',
    '{}',
    '{}',
    '{}',
    TRUE
  );
