-- Migration: valuation_settings — general, admin-editable operational config
-- for the valuation feature (mirrors global_chat_config / comment_config).
--
-- This single-row table holds the OPERATIONAL knobs that admins tune live from
-- the cat-admin panel, kept separate from the versioned, methodology-sensitive
-- valuation_config doc (calibration tiers, comps gate, term counts, category
-- comments) which stays seeded out-of-band.
--
--   enabled             - feature on/off (replaces the VALUATION_ENABLED env var)
--   window_days         - rolling quota window
--   quota_admin         - generations/window for users.is_admin (NULL = unlimited)
--   quota_avatar        - owns >=1 ENS name with an avatar (NULL = unlimited)
--   quota_name          - owns >=1 ENS name, none with avatar
--   quota_default       - owns no ENS name
--   evidence_cache_days - Tier-1 semantic evidence cache TTL
--   valuation_days      - Tier-2 full valuation cache TTL
--
-- A missing/unreadable row is treated as DISABLED (fail-safe) by the loader.
-- Created: 2026-06-15

CREATE TABLE IF NOT EXISTS valuation_settings (
    id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    window_days         INTEGER NOT NULL DEFAULT 7,
    quota_admin         INTEGER,                       -- NULL = unlimited
    quota_avatar        INTEGER,                       -- NULL = unlimited
    quota_name          INTEGER NOT NULL DEFAULT 25,
    quota_default       INTEGER NOT NULL DEFAULT 10,
    evidence_cache_days INTEGER NOT NULL DEFAULT 365,
    valuation_days      INTEGER NOT NULL DEFAULT 30,
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed the single row. quota_avatar defaults to 60 (high but finite); quota_admin
-- stays NULL = unlimited.
INSERT INTO valuation_settings (id, quota_avatar) VALUES (1, 60)
  ON CONFLICT (id) DO NOTHING;
