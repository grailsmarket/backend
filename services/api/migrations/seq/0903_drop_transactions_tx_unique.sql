-- Drop the tx-only unique constraint on transactions (replaced by transactions_tx_name_key
-- in 0901). Apply AFTER the indexer deploy that switches ON CONFLICT (transaction_hash) to
-- ON CONFLICT (transaction_hash, ens_name_id): until then the old code still targets this
-- constraint, and once it is gone a second name in the same tx (bulk register/renew, batch
-- transfer) can be recorded.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_hash_key;
