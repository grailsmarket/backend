-- Track who soft-deleted a chat message (and why), so the UI can distinguish
-- author-deleted ("deleted by user") from admin-deleted ("deleted by Admin").
--
-- deleted_by is the user id of whoever performed the deletion: the author for
-- a self-delete, the admin for a moderation delete. The "deleted by admin"
-- distinction is derived at the API layer as (deleted_by IS NOT NULL AND
-- deleted_by <> sender_user_id) — no extra column needed. deleted_reason mirrors
-- the comments precedent (0861) and carries the admin's moderation reason.
-- Created: 2026-06-15

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT;
