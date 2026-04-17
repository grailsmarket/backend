-- Migration: Add admin_broadcasts audit table for custom admin notifications
-- sent to paid subscribers (tier_id >= 1). Each row represents one send action
-- (broadcast or test), not one recipient — per-recipient rows live in notifications.

CREATE TABLE IF NOT EXISTS admin_broadcasts (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link_url TEXT,
    min_tier_id INTEGER NOT NULL,
    channels JSONB NOT NULL,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    sent_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_created_at ON admin_broadcasts(created_at DESC);
