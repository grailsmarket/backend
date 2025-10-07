-- ENS Names table
CREATE TABLE IF NOT EXISTS ens_names (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    token_id VARCHAR(78) UNIQUE NOT NULL,
    owner_address VARCHAR(42) NOT NULL,
    registrant VARCHAR(42),
    expiry_date TIMESTAMP,
    registration_date TIMESTAMP,
    last_transfer_date TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Listings table
CREATE TABLE IF NOT EXISTS listings (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER REFERENCES ens_names(id) ON DELETE CASCADE,
    seller_address VARCHAR(42) NOT NULL,
    price_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42) DEFAULT '0x0000000000000000000000000000000000000000',
    order_hash VARCHAR(66) UNIQUE,
    order_data JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    CONSTRAINT valid_status CHECK (status IN ('active', 'sold', 'cancelled', 'expired'))
);

-- Offers table
CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER REFERENCES ens_names(id) ON DELETE CASCADE,
    buyer_address VARCHAR(42) NOT NULL,
    offer_amount_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42) DEFAULT '0x0000000000000000000000000000000000000000',
    order_hash VARCHAR(66) UNIQUE,
    order_data JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    CONSTRAINT valid_status CHECK (status IN ('pending', 'accepted', 'rejected', 'expired'))
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER REFERENCES ens_names(id) ON DELETE CASCADE,
    transaction_hash VARCHAR(66) UNIQUE NOT NULL,
    block_number BIGINT NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    price_wei VARCHAR(78),
    transaction_type VARCHAR(20) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT valid_type CHECK (transaction_type IN ('sale', 'transfer', 'registration', 'renewal'))
);

-- Events log table (for reorg handling)
CREATE TABLE IF NOT EXISTS blockchain_events (
    id SERIAL PRIMARY KEY,
    block_number BIGINT NOT NULL,
    transaction_hash VARCHAR(66) NOT NULL,
    log_index INTEGER NOT NULL,
    contract_address VARCHAR(42) NOT NULL,
    event_name VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(transaction_hash, log_index)
);

-- Indexer state table
CREATE TABLE IF NOT EXISTS indexer_state (
    id SERIAL PRIMARY KEY,
    contract_address VARCHAR(42) UNIQUE NOT NULL,
    last_processed_block BIGINT NOT NULL DEFAULT 0,
    last_processed_timestamp TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_ens_names_owner ON ens_names(owner_address);
CREATE INDEX IF NOT EXISTS idx_ens_names_expiry ON ens_names(expiry_date);
CREATE INDEX IF NOT EXISTS idx_ens_names_name_lower ON ens_names(LOWER(name));

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_address);
CREATE INDEX IF NOT EXISTS idx_listings_created ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price_wei);

CREATE INDEX IF NOT EXISTS idx_offers_buyer ON offers(buyer_address);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_created ON offers(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_block ON transactions(block_number);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_address);

CREATE INDEX IF NOT EXISTS idx_events_block ON blockchain_events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_processed ON blockchain_events(processed);
CREATE INDEX IF NOT EXISTS idx_events_contract ON blockchain_events(contract_address, event_name);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at triggers
DROP TRIGGER IF EXISTS update_ens_names_updated_at ON ens_names;
CREATE TRIGGER update_ens_names_updated_at BEFORE UPDATE ON ens_names
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_listings_updated_at ON listings;
CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON listings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_indexer_state_updated_at ON indexer_state;
CREATE TRIGGER update_indexer_state_updated_at BEFORE UPDATE ON indexer_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable logical replication for WAL listener
-- Note: These commands need to be run as superuser
-- ALTER SYSTEM SET wal_level = logical;
-- ALTER SYSTEM SET max_replication_slots = 10;
-- ALTER SYSTEM SET max_wal_senders = 10;