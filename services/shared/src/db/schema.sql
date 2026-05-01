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

-- ============================================================================
-- Chat / messaging (added by migrations 0844–0849)
-- The `users` table is created in services/api/migrations/seq/0011_create_users_table.sql
-- and extended over time. Below are only the chat-specific additions; mirror
-- of migrations 0844–0849 for reference.
-- ============================================================================

-- users.accept_messages and users.is_stub (from 0844)
-- ALTER TABLE users
--   ADD COLUMN accept_messages BOOLEAN NOT NULL DEFAULT TRUE,
--   ADD COLUMN is_stub          BOOLEAN NOT NULL DEFAULT FALSE;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chats (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type               VARCHAR(16) NOT NULL DEFAULT 'direct'
                         CHECK (type IN ('direct', 'group')),
    title              VARCHAR(120),
    dm_key             VARCHAR(80) UNIQUE,
    created_by_user_id INTEGER NOT NULL,
    created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
    last_message_at    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chats_last_message_at ON chats(last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_chats_created_by_user_id ON chats(created_by_user_id);

CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id              UUID    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id              INTEGER NOT NULL,
    joined_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    left_at              TIMESTAMP,
    role                 VARCHAR(16) NOT NULL DEFAULT 'member'
                           CHECK (role IN ('member', 'admin')),
    last_read_message_id UUID,
    muted                BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id         UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_user_id  INTEGER NOT NULL,
    body            TEXT NOT NULL,
    content_type    VARCHAR(16) NOT NULL DEFAULT 'text'
                      CHECK (content_type IN ('text')),
    metadata        JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    edited_at       TIMESTAMP,
    deleted_at      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_blocks (
    blocker_user_id INTEGER NOT NULL,
    blocked_user_id INTEGER NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_user_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_blocks_blocked ON message_blocks(blocked_user_id);

-- AFTER INSERT trigger on messages: updates chats.last_message_at and emits
-- pg_notify('chat_message_created', {message_id, chat_id}) for the in-process
-- ChatNotifier WebSocket fan-out (see services/api/src/services/chat-notifier.ts).
CREATE OR REPLACE FUNCTION notify_chat_message_created()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE chats SET last_message_at = NEW.created_at WHERE id = NEW.chat_id;
    PERFORM pg_notify(
        'chat_message_created',
        json_build_object('message_id', NEW.id, 'chat_id', NEW.chat_id)::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_message_created_trigger ON messages;
CREATE TRIGGER chat_message_created_trigger
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION notify_chat_message_created();

-- ============================================================================
-- Comments feature (mirror of migration 0861_create_comments.sql)
-- ============================================================================

CREATE TABLE IF NOT EXISTS comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ens_name_id     INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL,
    body            TEXT NOT NULL,
    body_censored   TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'visible'
                      CHECK (status IN ('visible', 'deleted', 'hidden')),
    deleted_at      TIMESTAMP,
    deleted_by      INTEGER,
    deleted_reason  TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_ens_name_created
  ON comments(ens_name_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_user_created
  ON comments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_visible_ens_name_created
  ON comments(ens_name_id, created_at DESC) WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS idx_comments_status_created
  ON comments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS comment_user_status (
    user_id              INTEGER PRIMARY KEY,
    status               VARCHAR(16) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'warned', 'suspended', 'banned')),
    suspended_until      TIMESTAMP,
    deletion_count_30d   INTEGER NOT NULL DEFAULT 0,
    last_warned_at       TIMESTAMP,
    last_action_by       INTEGER,
    last_action_reason   TEXT,
    updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comment_blacklist_terms (
    id          SERIAL PRIMARY KEY,
    term        TEXT NOT NULL,
    action      VARCHAR(16) NOT NULL DEFAULT 'censor'
                  CHECK (action IN ('censor', 'block')),
    created_by  INTEGER,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_blacklist_terms_lower
  ON comment_blacklist_terms (LOWER(term));

CREATE TABLE IF NOT EXISTS comment_config (
    id                       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    warning_threshold        INTEGER NOT NULL DEFAULT 3,
    suspension_threshold     INTEGER NOT NULL DEFAULT 5,
    suspension_window_days   INTEGER NOT NULL DEFAULT 30,
    default_suspension_days  INTEGER NOT NULL DEFAULT 7,
    quota_cap                INTEGER NOT NULL DEFAULT 50,
    quota_floor              INTEGER NOT NULL DEFAULT 1,
    quota_names_weight       NUMERIC(8,2) NOT NULL DEFAULT 1.0,
    quota_listings_weight    NUMERIC(8,2) NOT NULL DEFAULT 2.0,
    quota_eth_weight         NUMERIC(8,2) NOT NULL DEFAULT 5.0,
    max_comment_length       INTEGER NOT NULL DEFAULT 500,
    updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comment_moderation_log (
    id           SERIAL PRIMARY KEY,
    comment_id   UUID,
    user_id      INTEGER,
    admin_id     INTEGER,
    action       VARCHAR(32) NOT NULL
                   CHECK (action IN ('delete', 'warn', 'suspend', 'ban', 'unban',
                                     'blacklist_add', 'blacklist_remove',
                                     'config_update', 'auto_warn', 'auto_suspend')),
    reason       TEXT,
    metadata     JSONB,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comment_moderation_log_user
  ON comment_moderation_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_moderation_log_admin
  ON comment_moderation_log(admin_id, created_at DESC);

-- Comment notification preferences (mirror of migration 0862)
-- ALTER TABLE users
--   ADD COLUMN notify_on_comment_received BOOLEAN NOT NULL DEFAULT TRUE;
-- ALTER TABLE watchlist
--   ADD COLUMN notify_on_comment BOOLEAN NOT NULL DEFAULT FALSE;