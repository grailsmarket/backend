-- Attach an optional image URL to an admin broadcast.
-- Served to recipients via in-app notification metadata and email template.

ALTER TABLE admin_broadcasts
    ADD COLUMN IF NOT EXISTS image_url TEXT;
