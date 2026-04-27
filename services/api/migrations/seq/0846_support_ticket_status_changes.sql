-- Audit trail for support ticket status changes.
-- Captures actor and direction so admins can see internally who did what,
-- including user-initiated reopens.

CREATE TABLE IF NOT EXISTS support_ticket_status_changes (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    actor_role VARCHAR(10) NOT NULL CHECK (actor_role IN ('user', 'admin')),
    from_status VARCHAR(20),
    to_status VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_status_changes_ticket
    ON support_ticket_status_changes(ticket_id, created_at DESC);
