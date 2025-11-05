-- Migration: Add message queue support
-- Date: 2025-10-07
-- Description: Adds notifications table, indexes for expiry, and resolver address column

-- 1. Add notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    ens_name_id INTEGER REFERENCES ens_names(id) ON DELETE CASCADE,
    metadata JSONB DEFAULT '{}',
    sent_at TIMESTAMP DEFAULT NOW(),
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_ens_name ON notifications(ens_name_id);

-- 2. Add resolver_address column to ens_names (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ens_names' AND column_name = 'resolver_address'
    ) THEN
        ALTER TABLE ens_names ADD COLUMN resolver_address VARCHAR(42);
    END IF;
END $$;

-- 3. Add indexes for expiry optimization
CREATE INDEX IF NOT EXISTS idx_listings_expires_at
ON listings(expires_at)
WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offers_expires_at
ON offers(expires_at)
WHERE status = 'pending' AND expires_at IS NOT NULL;

-- 4. Add index for ENS names with active listings (for daily sync)
CREATE INDEX IF NOT EXISTS idx_ens_names_has_listings
ON listings(ens_name_id, status)
WHERE status = 'active';

-- 5. Add has_emoji and has_numbers columns if they don't exist (for search)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ens_names' AND column_name = 'has_emoji'
    ) THEN
        ALTER TABLE ens_names ADD COLUMN has_emoji BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ens_names' AND column_name = 'has_numbers'
    ) THEN
        ALTER TABLE ens_names ADD COLUMN has_numbers BOOLEAN DEFAULT false;
    END IF;
END $$;

-- Note: pg-boss tables will be created automatically by pg-boss on first start
-- They will be created in the 'pgboss' schema
