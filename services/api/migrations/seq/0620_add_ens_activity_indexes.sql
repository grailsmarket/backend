-- Add composite indexes on transactions table for efficient per-address
-- ENS activity timestamp queries (lastRenewedAt, lastTransferInAt, lastTransferOutAt).
-- These support index-only scans for MAX(timestamp) grouped by address + type.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_from_type_ts
  ON transactions(from_address, transaction_type, timestamp DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_to_type_ts
  ON transactions(to_address, transaction_type, timestamp DESC);
