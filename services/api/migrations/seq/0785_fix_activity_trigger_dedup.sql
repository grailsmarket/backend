-- Add deduplication guard to the create_activity_on_sale() trigger function.
-- This prevents duplicate activity_history records when the same sale is detected
-- by both the OpenSea Stream and Seaport Indexer, which can create separate sale
-- records with different transaction hashes (synthetic vs real blockchain hash).

CREATE OR REPLACE FUNCTION create_activity_on_sale()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if activity records already exist for this sale to prevent duplicates.
    -- This can happen when both OpenSea Stream and Seaport Indexer detect the same trade.
    IF EXISTS (
        SELECT 1 FROM activity_history
        WHERE ens_name_id = NEW.ens_name_id
          AND event_type = 'sold'
          AND actor_address = NEW.seller_address
          AND (
              -- Match by real transaction hash
              (NEW.transaction_hash NOT LIKE 'opensea_%' AND transaction_hash = NEW.transaction_hash)
              OR
              -- Match by sale metadata (covers synthetic hash case)
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
            'offer_id', NEW.offer_id
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
            'offer_id', NEW.offer_id
        ),
        NEW.sale_date
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
