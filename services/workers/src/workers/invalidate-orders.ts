import PgBoss from 'pg-boss';
import { getPostgresPool, getOrderNftItem, checkEnsV2OrderItem, getEnsV2State } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, type InvalidateStaleOrdersJob } from '../queue';
import { createNotification } from './status-update-handler';

/**
 * Stale ENSv2 order worker
 *
 * Published by the indexer when an ENSv2 name gets a new token: a v1 name migrated, the name
 * was re-registered, or its token was regenerated (roles changed). Orders signed against the
 * old token can never be filled, so they're cancelled and the seller/buyer told to re-list.
 *
 * Only orders whose NFT item no longer matches the name's CURRENT ETHRegistry token are
 * cancelled, so re-indexing an old block range never cancels a valid order. An unregistered
 * name keeps its last (now burned) token ID in ens_names, so its current token ID is read
 * on-chain instead: unregistering bumps the token version, so every existing order is stale.
 */
export async function registerInvalidateOrdersWorker(boss: PgBoss): Promise<void> {
  await boss.work<InvalidateStaleOrdersJob>(
    QUEUE_NAMES.INVALIDATE_STALE_ORDERS,
    { teamSize: 2, teamConcurrency: 1 },
    async (job) => {
      const { ensNameId, reason } = job.data;
      const pool = getPostgresPool();

      const nameResult = await pool.query(
        'SELECT name, token_id, ens_version FROM ens_names WHERE id = $1',
        [ensNameId]
      );
      const name = nameResult.rows[0];
      if (!name || name.ens_version !== 2) {
        return;
      }

      // Throws (and the job retries) if the chain can't be reached
      const currentTokenId = reason === 'unregistered'
        ? (await getEnsV2State(name.token_id)).tokenId
        : name.token_id;

      const isStale = (orderData: any, side: 'listing' | 'offer') => {
        const data = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;
        const params = data?.protocol_data?.parameters ?? data?.parameters ?? data ?? {};
        return checkEnsV2OrderItem(getOrderNftItem(params, side), currentTokenId) !== null;
      };

      const listings = await pool.query(
        `SELECT id, seller_address, order_data FROM listings
         WHERE ens_name_id = $1 AND status IN ('active', 'unfunded')`,
        [ensNameId]
      );
      for (const listing of listings.rows.filter((l) => isStale(l.order_data, 'listing'))) {
        const updated = await pool.query(
          `UPDATE listings
           SET status = 'cancelled', unfunded_reason = $2, updated_at = NOW()
           WHERE id = $1 AND status IN ('active', 'unfunded')
           RETURNING id`,
          [listing.id, reason]
        );
        if (updated.rows.length === 0) continue;
        await createNotification({
          user_address: listing.seller_address,
          type: 'listing_cancelled',
          ens_name_id: ensNameId,
          title: 'Listing Cancelled',
          message: `Your listing for ${name.name} can no longer be filled because the name's token changed (${reason}). List it again to sell it.`,
          data: { listing_id: listing.id, name: name.name, reason },
        });
        logger.info({ listingId: listing.id, name: name.name, reason }, 'Cancelled stale ENSv2 listing');
      }

      const offers = await pool.query(
        `SELECT id, buyer_address, order_data FROM offers
         WHERE ens_name_id = $1 AND status IN ('pending', 'unfunded')`,
        [ensNameId]
      );
      for (const offer of offers.rows.filter((o) => isStale(o.order_data, 'offer'))) {
        const updated = await pool.query(
          `UPDATE offers
           SET status = 'cancelled', unfunded_reason = $2
           WHERE id = $1 AND status IN ('pending', 'unfunded')
           RETURNING id`,
          [offer.id, reason]
        );
        if (updated.rows.length === 0) continue;
        await createNotification({
          user_address: offer.buyer_address,
          type: 'offer_cancelled',
          ens_name_id: ensNameId,
          title: 'Offer Cancelled',
          message: `Your offer on ${name.name} can no longer be accepted because the name's token changed (${reason}). Make a new offer to bid again.`,
          data: { offer_id: offer.id, name: name.name, reason },
        });
        logger.info({ offerId: offer.id, name: name.name, reason }, 'Cancelled stale ENSv2 offer');
      }
    }
  );

  logger.info('Stale ENSv2 order worker registered');
}
