-- Compromised (stolen) names.
--
-- Names taken from their owners in an exploit (e.g. the 2026-09 Magic Eden / Limit Break Payment
-- Processor V2 approval drain) are flagged so the marketplace can:
--   * show a warning banner / badge on the name,
--   * only let the ORIGINAL owner (or an admin-approved recovery wallet) buy an active listing or
--     have their offer accepted — every other counterparty is greyed out in the app and rejected
--     by POST /offers,
--   * withhold signed order_data from API responses unless the caller is allowed to use it,
--   * prompt the original owner to revoke the malicious operator approval before buying back.
--
-- A flag resolves (status = 'resolved') when the name is back with an allowed wallet, or when it
-- expired and was re-registered after it was taken (see the resolve-compromised-names worker).

BEGIN;

-- 1. One row per exploit. malicious_operators are the approved operator contracts that were
--    abused; the app checks isApprovedForAll(wallet, operator) on the ENS registrar + NameWrapper
--    and asks the wallet to revoke before proceeding.
CREATE TABLE IF NOT EXISTS compromise_incidents (
  id                  SERIAL PRIMARY KEY,
  slug                VARCHAR(64) NOT NULL UNIQUE,
  title               VARCHAR(200) NOT NULL,
  description         TEXT,
  info_url            TEXT,
  malicious_operators VARCHAR(42)[] NOT NULL DEFAULT '{}',  -- lowercased
  occurred_at         TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. One row per stolen name.
CREATE TABLE IF NOT EXISTS compromised_names (
  id                SERIAL PRIMARY KEY,
  incident_id       INTEGER NOT NULL REFERENCES compromise_incidents(id),
  ens_name_id       INTEGER REFERENCES ens_names(id) ON DELETE SET NULL,  -- NULL until the name is in ens_names
  name              VARCHAR(255) NOT NULL UNIQUE,     -- ENSIP-15 normalized
  token_id          VARCHAR(78),                      -- as reported (labelhash or NameWrapper namehash)
  original_owner    VARCHAR(42) NOT NULL,             -- wallet it was taken from (lowercased)
  allowed_addresses VARCHAR(42)[] NOT NULL DEFAULT '{}',  -- extra recovery wallets (lowercased)
  taken_by          VARCHAR(42),
  taken_tx_hash     VARCHAR(66),
  taken_block       BIGINT,
  taken_at          TIMESTAMPTZ,
  status            VARCHAR(16) NOT NULL DEFAULT 'active',
  resolved_at       TIMESTAMP,
  resolved_reason   VARCHAR(64),
  notes             TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_compromised_status CHECK (status IN ('active', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_compromised_names_ens_name_active
  ON compromised_names(ens_name_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_compromised_names_token_id ON compromised_names(token_id);
CREATE INDEX IF NOT EXISTS idx_compromised_names_original_owner ON compromised_names(original_owner);

COMMIT;
