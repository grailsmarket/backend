-- Global chat config: single-row table (mirrors comment_config) editable from
-- the admin panel. Quota tiers are derived from ENS ownership in ens_names:
--   quota_with_avatar  - owns >=1 name with metadata->>'avatar' set (NULL = unlimited)
--   quota_with_name    - owns >=1 name, none with avatar
--   quota_without_name - owns no names
-- Created: 2026-06-10

CREATE TABLE IF NOT EXISTS global_chat_config (
    id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    quota_with_avatar   INTEGER,
    quota_with_name     INTEGER NOT NULL DEFAULT 20,
    quota_without_name  INTEGER NOT NULL DEFAULT 1,
    max_message_length  INTEGER NOT NULL DEFAULT 1000,
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO global_chat_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
