-- Create sales table for tracking completed ENS name sales
-- Migration: create_sales_table
-- Created: 2025-10-21

-- Create sales table
CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,

    -- ENS name reference
    ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,

    -- Sale parties
    seller_address VARCHAR(42) NOT NULL,
    buyer_address VARCHAR(42) NOT NULL,

    -- Sale details
    sale_price_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42) DEFAULT '0x0000000000000000000000000000000000000000',

    -- Links to original listing/offer (if applicable)
    listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
    offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,

    -- Blockchain details
    transaction_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,

    -- Seaport order data
    order_hash VARCHAR(66),
    order_data JSONB,

    -- Marketplace info
    source VARCHAR(20) NOT NULL DEFAULT 'grails',
    platform_fee_wei VARCHAR(78),
    creator_fee_wei VARCHAR(78),

    -- Additional metadata
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Timestamps
    sale_date TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_source CHECK (source IN ('opensea', 'grails', 'blur', 'looksrare', 'x2y2', 'other')),
    -- Ensure unique sales per transaction (same tx hash shouldn't create duplicate sales)
    CONSTRAINT unique_transaction_sale UNIQUE (transaction_hash, ens_name_id)
);

-- Create indexes for efficient querying
CREATE INDEX idx_sales_ens_name_id ON sales(ens_name_id);
CREATE INDEX idx_sales_seller_address ON sales(seller_address);
CREATE INDEX idx_sales_buyer_address ON sales(buyer_address);
CREATE INDEX idx_sales_sale_date ON sales(sale_date DESC);
CREATE INDEX idx_sales_transaction_hash ON sales(transaction_hash);
CREATE INDEX idx_sales_block_number ON sales(block_number);
CREATE INDEX idx_sales_source ON sales(source);
CREATE INDEX idx_sales_listing_id ON sales(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX idx_sales_offer_id ON sales(offer_id) WHERE offer_id IS NOT NULL;

-- Composite indexes for common query patterns
CREATE INDEX idx_sales_name_date ON sales(ens_name_id, sale_date DESC);
CREATE INDEX idx_sales_seller_date ON sales(seller_address, sale_date DESC);
CREATE INDEX idx_sales_buyer_date ON sales(buyer_address, sale_date DESC);
CREATE INDEX idx_sales_source_date ON sales(source, sale_date DESC);

-- Add comments for documentation
COMMENT ON TABLE sales IS 'Tracks completed sales of ENS names on various marketplaces';
COMMENT ON COLUMN sales.seller_address IS 'Address of the seller who sold the ENS name';
COMMENT ON COLUMN sales.buyer_address IS 'Address of the buyer who purchased the ENS name';
COMMENT ON COLUMN sales.sale_price_wei IS 'Final sale price in wei';
COMMENT ON COLUMN sales.currency_address IS 'Payment token address (0x0 for ETH)';
COMMENT ON COLUMN sales.listing_id IS 'Reference to the listing that was fulfilled (if from a listing)';
COMMENT ON COLUMN sales.offer_id IS 'Reference to the offer that was accepted (if from an offer)';
COMMENT ON COLUMN sales.source IS 'Marketplace where the sale occurred';
COMMENT ON COLUMN sales.platform_fee_wei IS 'Fee paid to the marketplace platform in wei';
COMMENT ON COLUMN sales.creator_fee_wei IS 'Fee paid to creators/royalties in wei';
COMMENT ON COLUMN sales.metadata IS 'Additional sale-specific data (fees breakdown, etc.)';
COMMENT ON COLUMN sales.sale_date IS 'Timestamp when the sale was completed on-chain';

-- Function to update related listings when a sale is recorded
CREATE OR REPLACE FUNCTION mark_listing_sold_on_sale()
RETURNS TRIGGER AS $$
BEGIN
    -- If this sale references a listing, mark it as sold
    IF NEW.listing_id IS NOT NULL THEN
        UPDATE listings
        SET status = 'sold',
            updated_at = NOW()
        WHERE id = NEW.listing_id
          AND status = 'active';
    END IF;

    -- If this sale references an offer, mark it as accepted
    IF NEW.offer_id IS NOT NULL THEN
        UPDATE offers
        SET status = 'accepted'
        WHERE id = NEW.offer_id
          AND status = 'pending';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update listings/offers on sale
DROP TRIGGER IF EXISTS update_listing_offer_on_sale ON sales;
CREATE TRIGGER update_listing_offer_on_sale
    AFTER INSERT ON sales
    FOR EACH ROW
    EXECUTE FUNCTION mark_listing_sold_on_sale();

-- Function to create activity_history entry when a sale is recorded
CREATE OR REPLACE FUNCTION create_activity_on_sale()
RETURNS TRIGGER AS $$
BEGIN
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

-- Create trigger to auto-create activity history on sale
DROP TRIGGER IF EXISTS create_activity_history_on_sale ON sales;
CREATE TRIGGER create_activity_history_on_sale
    AFTER INSERT ON sales
    FOR EACH ROW
    EXECUTE FUNCTION create_activity_on_sale();
