-- Grails anniversary NFT claim allowlist.
--
-- One row per eligible address, each with a token id fixed in advance: "special" (power users)
-- get the low ids 1..N, "generic" the rest. Claims are checked onchain against an OpenZeppelin
-- StandardMerkleTree whose leaves are (address account, uint256 tokenId); the proof stored here
-- is what the frontend passes to claim(account, tokenId, proof).
--
-- Loaded from the generator's proofs.json by scripts/import-anniversary-proofs.ts, which replaces
-- the whole table in one transaction. Served by GET /api/v1/anniversary/proof/:address.
--
-- Purely additive: one new table.

CREATE TABLE IF NOT EXISTS anniversary_nft_claims (
  address      VARCHAR(42)   PRIMARY KEY,         -- lowercase
  token_id     INTEGER       NOT NULL UNIQUE,
  nft_type     VARCHAR(16)   NOT NULL,
  proof        VARCHAR(66)[] NOT NULL,            -- bytes32 hex, leaf to root
  merkle_root  VARCHAR(66)   NOT NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_anniversary_nft_type CHECK (nft_type IN ('special', 'generic')),
  CONSTRAINT valid_anniversary_token_id CHECK (token_id > 0)
);
