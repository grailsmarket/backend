-- Grails fill attribution.
--
-- A sale's `source` records which marketplace the order ORIGINATED on (opensea/vision/grails…)
-- and drives the marketplace logo. It cannot tell whether a foreign (OpenSea/Vision) order was
-- filled on that marketplace's own UI or executed through the Grails app — both emit the same
-- on-chain OrderFulfilled event and yield the same `source`.
--
-- This adds an independent `filled_via` attribution: where the fill was EXECUTED. The Grails app
-- reports the fulfillment tx hash to POST /api/v1/fills (recorded in `order_fills`); createSale()
-- consults that log and, after verifying the reported filler matches the on-chain buyer/seller,
-- stamps sales.filled_via = 'grails'. `source` is left untouched, so the origin logo is preserved.

-- 1. Independent fill-venue flag on sales (NULL = unknown / filled on the origin marketplace's UI).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS filled_via VARCHAR(20);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_filled_via') THEN
    ALTER TABLE sales ADD CONSTRAINT valid_filled_via
      CHECK (filled_via IS NULL OR filled_via IN ('grails'));
  END IF;
END
$do$;

-- 2. Off-chain attribution log: one row per (tx, order) the Grails app reports it broadcast.
CREATE TABLE IF NOT EXISTS order_fills (
  id               SERIAL PRIMARY KEY,
  order_hash       VARCHAR(66) NOT NULL,
  transaction_hash VARCHAR(66) NOT NULL,
  filler_address   VARCHAR(42) NOT NULL,  -- wallet that executed the fill (lowercased)
  source           VARCHAR(20) NOT NULL DEFAULT 'grails',  -- the filled_via value to apply
  created_at       TIMESTAMP DEFAULT NOW(),
  CONSTRAINT uq_order_fill UNIQUE (transaction_hash, order_hash)
);

CREATE INDEX IF NOT EXISTS idx_order_fills_order_hash ON order_fills(order_hash);
CREATE INDEX IF NOT EXISTS idx_order_fills_tx_hash    ON order_fills(transaction_hash);

-- 3. Carry filled_via into the activity feed. Body is the dedup-guarded version from
--    0785_fix_activity_trigger_dedup.sql, with 'filled_via' added to both metadata blocks.
--    Trigger binding is unchanged (AFTER INSERT on sales) — CREATE OR REPLACE keeps it wired.
CREATE OR REPLACE FUNCTION create_activity_on_sale()
RETURNS TRIGGER AS $$
BEGIN
    -- Skip if activity records already exist for this sale (both OpenSea Stream and the Seaport
    -- indexer can detect the same trade and create separate sale rows / hashes).
    IF EXISTS (
        SELECT 1 FROM activity_history
        WHERE ens_name_id = NEW.ens_name_id
          AND event_type = 'sold'
          AND actor_address = NEW.seller_address
          AND (
              (NEW.transaction_hash NOT LIKE 'opensea_%' AND transaction_hash = NEW.transaction_hash)
              OR
              (metadata->>'sale_id')::integer = NEW.id
          )
        LIMIT 1
    ) THEN
        RETURN NEW;
    END IF;

    -- Insert sold activity for seller
    INSERT INTO activity_history (
        ens_name_id,
        event_type,
        actor_address,
        counterparty_address,
        platform,
        chain_id,
        price_wei,
        currency_address,
        transaction_hash,
        block_number,
        metadata,
        created_at
    ) VALUES (
        NEW.ens_name_id,
        'sold'::activity_event_type,
        NEW.seller_address,
        NEW.buyer_address,
        NEW.source,
        1, -- mainnet
        NEW.sale_price_wei,
        NEW.currency_address,
        NEW.transaction_hash,
        NEW.block_number,
        jsonb_build_object(
            'sale_id', NEW.id,
            'listing_id', NEW.listing_id,
            'offer_id', NEW.offer_id,
            'filled_via', NEW.filled_via
        ),
        NEW.sale_date
    );

    -- Insert bought activity for buyer
    INSERT INTO activity_history (
        ens_name_id,
        event_type,
        actor_address,
        counterparty_address,
        platform,
        chain_id,
        price_wei,
        currency_address,
        transaction_hash,
        block_number,
        metadata,
        created_at
    ) VALUES (
        NEW.ens_name_id,
        'bought'::activity_event_type,
        NEW.buyer_address,
        NEW.seller_address,
        NEW.source,
        1, -- mainnet
        NEW.sale_price_wei,
        NEW.currency_address,
        NEW.transaction_hash,
        NEW.block_number,
        jsonb_build_object(
            'sale_id', NEW.id,
            'listing_id', NEW.listing_id,
            'offer_id', NEW.offer_id,
            'filled_via', NEW.filled_via
        ),
        NEW.sale_date
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
