-- ENSv2 name identity.
--
-- ENSv2 names live in the ETHRegistry (ERC1155) with token IDs that change: a v2 token ID is
-- the labelhash with its low 32 bits replaced by a version counter that bumps whenever roles
-- on the name change (TokenRegenerated), and a migrated v1 name gets a new token ID entirely.
-- ens_names stays one row per name: token_id is the CURRENT tradeable ID, token_contract says
-- which contract it belongs to, and ens_token_ids keeps every ID the name has had so stale IDs
-- (old orders, late events) still resolve to the right row.
--
-- Existing rows are v1 (ens_version 1, token_contract NULL = v1 BaseRegistrar/NameWrapper,
-- implied by the token_id format as before). Adding columns with constant defaults is a
-- metadata-only change in Postgres 11+.

ALTER TABLE ens_names
  ADD COLUMN IF NOT EXISTS ens_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS token_contract varchar(42),
  ADD COLUMN IF NOT EXISTS labelhash varchar(66);

COMMENT ON COLUMN ens_names.ens_version IS '1 = ENS v1 (BaseRegistrar/NameWrapper), 2 = ENSv2 ETHRegistry';
COMMENT ON COLUMN ens_names.token_contract IS 'Contract of token_id; NULL for v1 rows (implied by token_id format)';
COMMENT ON COLUMN ens_names.labelhash IS 'Full keccak256 labelhash (set for v2 rows); stable across v1/v2 and token regeneration';

CREATE TABLE IF NOT EXISTS ens_token_ids (
  token_contract varchar(42) NOT NULL,
  token_id varchar(78) NOT NULL,
  ens_name_id integer NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  ens_version smallint NOT NULL,
  -- registered | migrated | regenerated
  reason varchar(20) NOT NULL,
  transaction_hash varchar(66),
  block_number bigint,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (token_contract, token_id)
);

CREATE INDEX IF NOT EXISTS idx_ens_token_ids_ens_name_id ON ens_token_ids (ens_name_id);

COMMENT ON TABLE ens_token_ids IS 'Every token ID an ENSv2 name has had (current and superseded), for resolving stale IDs';

-- v2 registrations/renewals are paid in ERC20s (USDC/DAI), not ETH. Amounts in the *_wei
-- columns are in the payment token's base units; NULL currency = native ETH (all v1 rows).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS currency_address varchar(42);
ALTER TABLE renewals ADD COLUMN IF NOT EXISTS currency_address varchar(42);

-- One transactions row per (tx, name) instead of per tx, so a bulk register/renew or a
-- batch transfer records every name. The old tx-only constraint is dropped by 0903 AFTER
-- the indexer code that targets this constraint is deployed.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_tx_name_key UNIQUE (transaction_hash, ens_name_id);
