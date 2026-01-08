-- Optimize activity_history indexes for global feed query performance
-- The global feed filters by event_type and orders by created_at DESC

-- Composite index for event_type + created_at (covers the common global feed query)
CREATE INDEX IF NOT EXISTS idx_activity_history_event_type_created
ON activity_history(event_type, created_at DESC);

-- Index on created_at DESC for fast pagination without event_type filter
-- (the existing idx_activity_history_created_at may not be DESC)
CREATE INDEX IF NOT EXISTS idx_activity_history_created_at_desc
ON activity_history(created_at DESC);
