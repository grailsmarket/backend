-- Fix mis-attributed crypto.eth sale (tx 0x0bca49fa…, 55 ETH, 2026-08-21).
--
-- The buyer purchased the 55 ETH Grails listing (Seaport order 0x9e8cee…, Grails conduit,
-- paid in native ETH), but the OpenSea Stream item_sold handler matched offers heuristically
-- by "any open offer from this buyer on this name" and found the buyer's unrelated, still-open
-- 30 WETH OpenSea offer. That flipped sales.source to 'opensea', attached the wrong offer_id,
-- and the mark_listing_sold_on_sale trigger then wrongly marked that offer 'accepted' (which
-- emitted a bogus offer_accepted activity). The code fix makes order-hash matching
-- authoritative and never attributes native-ETH sales to offers; this migration repairs the
-- data for this sale.

-- 1. Point the sale at the listing that was actually fulfilled and detach the unrelated offer.
UPDATE sales
SET source       = 'grails',
    listing_id   = (SELECT id FROM listings
                    WHERE order_hash = '0x9e8cee8eda005d8b967df2bf4c8d0a6e4079c71822079b189c90583a52725155'
                    ORDER BY created_at DESC LIMIT 1),
    offer_id     = NULL,
    order_hash   = '0x9e8cee8eda005d8b967df2bf4c8d0a6e4079c71822079b189c90583a52725155',
    block_number = 25804084
WHERE id = 441234
  AND transaction_hash = '0x0bca49fade1c7cc9260d68afadaedb2f4c2b0bcd111431129a140c33fbf5fd71';

-- 2. Fix the bought/sold activity rows the sale trigger created (platform + metadata linkage).
UPDATE activity_history
SET platform     = 'grails',
    block_number = 25804084,
    metadata     = (metadata - 'offer_id')
                   || jsonb_build_object('listing_id', (SELECT listing_id FROM sales WHERE id = 441234))
WHERE (metadata->>'sale_id')::integer = 441234
  AND event_type IN ('bought', 'sold');

-- 3. Remove the bogus offer_accepted event — the 30 WETH offer was never accepted.
DELETE FROM activity_history
WHERE id = 6241754
  AND event_type = 'offer_accepted'
  AND (metadata->>'offer_id')::integer = 2562783;

-- 4. Revert the offer the trigger wrongly flipped to 'accepted'. It is still a live Seaport
--    order; the validation workers will re-validate it (the offerer now owns the name, so it
--    may legitimately end up invalid/unfunded — that is accurate).
UPDATE offers
SET status = 'pending'
WHERE id = 2562783
  AND status = 'accepted';

-- 5. The 60 ETH Grails listing the heuristic wrongly linked (721574) was marked 'sold' by the
--    trigger; it was invalidated by the sale, not fulfilled.
UPDATE listings
SET status = 'cancelled', updated_at = NOW()
WHERE id = 721574
  AND status = 'sold';
