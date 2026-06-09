-- Allow 'vision' (ENS Vision) as a sale source.
--
-- Vision offers are ingested into the offers table with source='vision'. When such an
-- offer is accepted on-chain, the Seaport indexer (handleOrderFulfilled) calls
-- createSale({ source: 'vision', ... }). The original valid_source CHECK (migration
-- 0150) only allowed 'opensea','grails','blur','looksrare','x2y2','other', so the INSERT
-- violated the constraint and threw. The indexer wraps createSale in a try/catch that
-- logs and continues, so ownership was still updated but NO sales row was created — which
-- meant the mark_listing_sold_on_sale trigger (that flips the matched offer to 'accepted')
-- never fired, leaving accepted Vision offers stuck in 'pending'.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS valid_source;
ALTER TABLE sales ADD CONSTRAINT valid_source
    CHECK (source IN ('opensea', 'grails', 'vision', 'blur', 'looksrare', 'x2y2', 'other'));
