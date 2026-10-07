-- Repair all sales hit by the offer-hijack attribution bug (see 0895 for the crypto.eth case).
--
-- Detector: a native-ETH sale linked to an offer is always wrong — Seaport offers are ERC20
-- (WETH), so a native-ETH payment can only be a direct listing purchase. Under the old logic
-- these sales took their `source` from the buyer's unrelated open offer, so the stored source
-- is untrustworthy in BOTH directions ('opensea' on a Grails listing purchase, and 'grails' on
-- an OpenSea listing purchase, depending on where the stale offer lived).
--
-- Repair, per affected sale:
--   1. Recompute source from the listing that was actually fulfilled: listings matched by
--      sales.order_hash (authoritative) > the currently-linked listing's source (heuristic
--      match made at sale time — right marketplace even if possibly the wrong row) > leave
--      source unchanged (no listing evidence; surfaced by the dry-run for manual review).
--   2. Re-link listing_id to the order-hash-matched listing and detach the offer.
--   3. Fix platform/metadata on the bought/sold activity rows the sale trigger created.
--   4. Revert offers the trigger wrongly flipped to 'accepted' (to 'expired' if past their
--      expiry, else 'pending' for the validation workers to re-check) — but only offers no
--      other (genuine) sale references — and delete their bogus offer_accepted activity.
--   5. Listings the heuristic mis-linked (marked 'sold' but not actually fulfilled) become
--      'cancelled'; the truly fulfilled listing becomes 'sold' if still 'active'.

WITH affected AS (
  SELECT s.id AS sale_id,
         s.order_hash,
         s.listing_id AS old_listing_id,
         s.offer_id   AS old_offer_id,
         s.source     AS old_source
  FROM sales s
  WHERE s.offer_id IS NOT NULL
    AND s.currency_address = '0x0000000000000000000000000000000000000000'
),
resolved AS (
  SELECT a.*,
         lh.id     AS fulfilled_listing_id,
         COALESCE(lh.source, ll.source, a.old_source) AS new_source,
         COALESCE(lh.id, a.old_listing_id)            AS new_listing_id
  FROM affected a
  LEFT JOIN listings lh ON a.order_hash IS NOT NULL AND lh.order_hash = a.order_hash
  LEFT JOIN listings ll ON ll.id = a.old_listing_id
),
upd_sales AS (
  UPDATE sales s
  SET source     = r.new_source,
      listing_id = r.new_listing_id,
      offer_id   = NULL
  FROM resolved r
  WHERE s.id = r.sale_id
  RETURNING s.id
),
upd_activity AS (
  UPDATE activity_history ah
  SET platform = r.new_source,
      metadata = (ah.metadata - 'offer_id')
                 || CASE WHEN r.new_listing_id IS NOT NULL
                         THEN jsonb_build_object('listing_id', r.new_listing_id)
                         ELSE '{}'::jsonb END
  FROM resolved r
  WHERE ah.event_type IN ('bought', 'sold')
    AND (ah.metadata->>'sale_id')::integer = r.sale_id
  RETURNING ah.id
),
upd_offers AS (
  UPDATE offers o
  SET status = CASE WHEN o.expires_at IS NOT NULL AND o.expires_at < NOW()
                    THEN 'expired' ELSE 'pending' END
  FROM (SELECT DISTINCT old_offer_id FROM resolved) r
  WHERE o.id = r.old_offer_id
    AND o.status = 'accepted'
    AND NOT EXISTS (
      SELECT 1 FROM sales s2
      WHERE s2.offer_id = o.id
        AND s2.id NOT IN (SELECT sale_id FROM resolved)
    )
  RETURNING o.id
),
del_offer_accepted AS (
  DELETE FROM activity_history ah
  USING upd_offers uo
  WHERE ah.event_type = 'offer_accepted'
    AND (ah.metadata->>'offer_id')::integer = uo.id
  RETURNING ah.id
),
fix_mislinked_listing AS (
  UPDATE listings l
  SET status = 'cancelled', updated_at = NOW()
  FROM resolved r
  WHERE l.id = r.old_listing_id
    AND r.fulfilled_listing_id IS NOT NULL
    AND r.old_listing_id IS DISTINCT FROM r.fulfilled_listing_id
    AND l.status = 'sold'
  RETURNING l.id
),
fix_fulfilled_listing AS (
  UPDATE listings l
  SET status = 'sold', updated_at = NOW()
  FROM resolved r
  WHERE l.id = r.fulfilled_listing_id
    AND l.status = 'active'
  RETURNING l.id
)
SELECT (SELECT count(*) FROM upd_sales)             AS sales_fixed,
       (SELECT count(*) FROM upd_activity)          AS activity_rows_fixed,
       (SELECT count(*) FROM upd_offers)            AS offers_reverted,
       (SELECT count(*) FROM del_offer_accepted)    AS bogus_offer_accepted_deleted,
       (SELECT count(*) FROM fix_mislinked_listing) AS mislinked_listings_cancelled,
       (SELECT count(*) FROM fix_fulfilled_listing) AS fulfilled_listings_marked_sold;
