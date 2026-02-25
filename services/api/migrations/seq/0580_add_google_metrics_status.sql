-- Add status column to google_metrics to distinguish real data from no-data results.
-- 'success' = Google returned real metrics; 'no_data' = Google returned empty (profane, obscure, etc.)
ALTER TABLE google_metrics
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'success';

-- Index for backfill worker queries that filter by status
CREATE INDEX IF NOT EXISTS idx_google_metrics_status ON google_metrics (status);
