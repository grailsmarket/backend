-- Migration: Comments feature
-- Adds: comments, comment_user_status, comment_blacklist_terms, comment_config,
--       comment_moderation_log
-- Created: 2026-04-30

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Comments posted on individual ENS names. Soft-deleted via status='deleted'.
-- body_censored is the user-visible variant when blacklisted terms are
-- censored (asterisks); reads should COALESCE(body_censored, body).
CREATE TABLE IF NOT EXISTS comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ens_name_id     INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    body_censored   TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'visible'
                      CHECK (status IN ('visible', 'deleted', 'hidden')),
    deleted_at      TIMESTAMP,
    deleted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    deleted_reason  TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_ens_name_created
  ON comments(ens_name_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_user_created
  ON comments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_visible_ens_name_created
  ON comments(ens_name_id, created_at DESC)
  WHERE status = 'visible';

CREATE INDEX IF NOT EXISTS idx_comments_status_created
  ON comments(status, created_at DESC);


-- One row per moderated user. Lazily created on first moderation event.
-- deletion_count_30d is a denormalized counter recomputed on each delete.
CREATE TABLE IF NOT EXISTS comment_user_status (
    user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status               VARCHAR(16) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'warned', 'suspended', 'banned')),
    suspended_until      TIMESTAMP,
    deletion_count_30d   INTEGER NOT NULL DEFAULT 0,
    last_warned_at       TIMESTAMP,
    last_action_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_action_reason   TEXT,
    updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);


-- Term blacklist. action='censor' replaces matches with asterisks; action='block'
-- rejects the comment outright. Match is case-insensitive at word boundaries.
CREATE TABLE IF NOT EXISTS comment_blacklist_terms (
    id          SERIAL PRIMARY KEY,
    term        TEXT NOT NULL,
    action      VARCHAR(16) NOT NULL DEFAULT 'censor'
                  CHECK (action IN ('censor', 'block')),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_blacklist_terms_lower
  ON comment_blacklist_terms (LOWER(term));


-- Single-row settings table; admin-editable thresholds and quota knobs.
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

INSERT INTO comment_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- Audit trail of moderation actions.
CREATE TABLE IF NOT EXISTS comment_moderation_log (
    id           SERIAL PRIMARY KEY,
    comment_id   UUID REFERENCES comments(id) ON DELETE SET NULL,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    admin_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_comment_moderation_log_comment
  ON comment_moderation_log(comment_id);

CREATE INDEX IF NOT EXISTS idx_comment_moderation_log_admin
  ON comment_moderation_log(admin_id, created_at DESC);


COMMENT ON TABLE comments IS 'User comments on individual ENS name pages';
COMMENT ON COLUMN comments.body IS 'Sanitized comment body (HTML stripped, URLs blocked, char-allowlist enforced)';
COMMENT ON COLUMN comments.body_censored IS 'Variant with blacklist terms replaced by asterisks; serve via COALESCE(body_censored, body)';
COMMENT ON COLUMN comments.status IS 'visible (default), deleted (soft-removed by mod), hidden (auto-hidden by blocked term)';

COMMENT ON TABLE comment_user_status IS 'Per-user comment moderation state; rows created lazily on first mod event';
COMMENT ON COLUMN comment_user_status.suspended_until IS 'Suspension lifts when NOW() > suspended_until; NULL means not suspended';
COMMENT ON COLUMN comment_user_status.deletion_count_30d IS 'Denormalized count of comments deleted in last suspension_window_days; recomputed by mod handler';

COMMENT ON TABLE comment_blacklist_terms IS 'Maintainable blacklist of terms; censor replaces with ***, block rejects the comment';

COMMENT ON TABLE comment_config IS 'Single-row settings table for comment thresholds and quota tuning';
COMMENT ON COLUMN comment_config.quota_cap IS 'Max daily comments any user can earn via the quota formula';
COMMENT ON COLUMN comment_config.quota_floor IS 'Min daily comments any logged-in user can post regardless of formula';

COMMENT ON TABLE comment_moderation_log IS 'Audit trail of all moderation actions (manual or automatic)';
