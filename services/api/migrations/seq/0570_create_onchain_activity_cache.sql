CREATE TABLE onchain_activity_cache (
    address VARCHAR(42) PRIMARY KEY,
    last_transaction_at TIMESTAMPTZ,
    last_transaction_hash VARCHAR(66),
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
