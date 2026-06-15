-- Migration: ENS name valuation feature
-- Adds: valuation_prompts, valuation_config, valuation_evidence_cache,
--       valuations, valuation_generations
--
-- The valuation feature is an AI-powered ENS name appraisal. This migration
-- creates the storage layer only. The methodology-sensitive content (LLM
-- prompts, calibration thresholds, category comments) is intentionally NOT
-- seeded here: this repo is open-source, so prompt/config text is loaded
-- out-of-band via the admin dashboard's SQL access. The tables ship empty.
--
-- Cache design is two-tier, time-only TTL:
--   - valuation_evidence_cache: stable per-label semantic evidence (~365d)
--   - valuations: full appraisal result per label (~30d)
-- Created: 2026-06-11

-- Versioned private prompt store. One active version per prompt_key. Content is
-- loaded via the admin dashboard, never via this migration. Loader fails closed
-- when the active row for a required key is missing.
CREATE TABLE IF NOT EXISTS valuation_prompts (
    id          SERIAL PRIMARY KEY,
    prompt_key  VARCHAR(64) NOT NULL,
    version     INTEGER NOT NULL,
    content     TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false,
    notes       TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (prompt_key, version)
);

-- Enforces at most one active row per prompt_key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_valuation_prompts_one_active
  ON valuation_prompts (prompt_key)
  WHERE is_active;


-- Versioned private config document: calibration thresholds + notes, comps gate,
-- per-sense term-count schedule, research-sense limit, category valuation
-- comments, activity floors/ignored categories, quota caps by tier, and TTLs.
-- Stored as a single JSONB document so the whole config can be versioned and
-- rolled back atomically. Loaded via the admin dashboard; ships empty.
CREATE TABLE IF NOT EXISTS valuation_config (
    id          SERIAL PRIMARY KEY,
    version     INTEGER NOT NULL UNIQUE,
    config      JSONB NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false,
    notes       TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Enforces at most one active config version (index value is constant `true`
-- across all active rows, so only one can exist).
CREATE UNIQUE INDEX IF NOT EXISTS idx_valuation_config_one_active
  ON valuation_config (is_active)
  WHERE is_active;


-- Tier 1 cache: stable per-label semantic evidence that rarely changes
-- (name research, related terms). Keyed by normalized .eth label (no suffix),
-- matching the ai_recommendations / google_metrics text-key convention.
CREATE TABLE IF NOT EXISTS valuation_evidence_cache (
    id          SERIAL PRIMARY KEY,
    label       VARCHAR(64) NOT NULL,
    kind        VARCHAR(32) NOT NULL,
    payload     JSONB NOT NULL,
    model       VARCHAR(96),
    expires_at  TIMESTAMP NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (label, kind)
);

-- Cleanup worker (Phase 2) prunes expired rows by this index.
CREATE INDEX IF NOT EXISTS idx_valuation_evidence_cache_expires_at
  ON valuation_evidence_cache (expires_at);


-- Tier 2 cache: full valuation result per label (~30d TTL). eth_value/low/high
-- are denormalized from the JSONB result for future querying/sorting.
CREATE TABLE IF NOT EXISTS valuations (
    id            SERIAL PRIMARY KEY,
    label         VARCHAR(64) NOT NULL UNIQUE,
    result        JSONB NOT NULL,
    eth_value     NUMERIC,
    low_eth       NUMERIC,
    high_eth      NUMERIC,
    model         VARCHAR(96),
    generated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at    TIMESTAMP NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_valuations_expires_at
  ON valuations (expires_at);


-- Quota audit: one row per actual generation run (the initiator only; clients
-- that attach to an in-flight stream are not charged). The rolling-window quota
-- counts completed rows here, mirroring the comment-quota pattern.
CREATE TABLE IF NOT EXISTS valuation_generations (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       VARCHAR(64) NOT NULL,
    run_id      VARCHAR(64) NOT NULL,
    status      VARCHAR(16) NOT NULL
                  CHECK (status IN ('completed', 'failed')),
    cost_usd    NUMERIC,
    duration_ms INTEGER,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Drives the rolling 7-day per-user quota count.
CREATE INDEX IF NOT EXISTS idx_valuation_generations_user_window
  ON valuation_generations (user_id, created_at DESC);


COMMENT ON TABLE valuation_prompts IS 'Versioned private LLM prompts for the valuation feature; content loaded out-of-band, not in migrations';
COMMENT ON COLUMN valuation_prompts.prompt_key IS 'name_research | scoped_terms | number_variants | appraisal';
COMMENT ON COLUMN valuation_prompts.content IS 'Prompt text with {{placeholders}} interpolated at call time';
COMMENT ON COLUMN valuation_prompts.is_active IS 'Exactly one active row per prompt_key (enforced by partial unique index)';

COMMENT ON TABLE valuation_config IS 'Versioned private valuation config (calibration thresholds/notes, comps gate, term-count schedule, category comments, quotas, TTLs); loaded out-of-band';
COMMENT ON COLUMN valuation_config.config IS 'Single JSONB document holding the full config for one version';
COMMENT ON COLUMN valuation_config.is_active IS 'Exactly one active config version (enforced by partial unique index)';

COMMENT ON TABLE valuation_evidence_cache IS 'Tier-1 cache: stable per-label semantic evidence (name_research, related_terms); ~365d TTL';
COMMENT ON COLUMN valuation_evidence_cache.label IS 'Normalized .eth label without suffix';
COMMENT ON COLUMN valuation_evidence_cache.kind IS 'Evidence kind: name_research | related_terms';

COMMENT ON TABLE valuations IS 'Tier-2 cache: full ValuationEvidenceResult per label; ~30d TTL';
COMMENT ON COLUMN valuations.label IS 'Normalized .eth label without suffix';
COMMENT ON COLUMN valuations.eth_value IS 'Denormalized appraisal value (ETH) for future querying/sorting';

COMMENT ON TABLE valuation_generations IS 'Audit + quota source: one row per actual generation run (initiators only); rolling-window quota counts completed rows';
COMMENT ON COLUMN valuation_generations.status IS 'completed (counts against quota) | failed (does not)';
