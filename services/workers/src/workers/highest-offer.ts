import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const pool = getPostgresPool();

interface UpdateHighestOfferJob {
  ensNameId: number;
  offerId: number;
  offerAmountWei: string;
  currencyAddress: string;
}

interface RecalculateHighestOfferJob {
  ensNameId: number;
}

/**
 * Update highest offer if new offer is higher than current
 * O(1) operation - just compare and update if higher
 */
async function updateHighestOffer(data: UpdateHighestOfferJob): Promise<void> {
  const { ensNameId, offerId, offerAmountWei, currencyAddress } = data;

  // Only track ETH offers for now
  if (currencyAddress !== '0x0000000000000000000000000000000000000000') {
    logger.debug({ ensNameId, currencyAddress }, 'Skipping non-ETH offer');
    return;
  }

  try {
    // Update only if new offer is higher than current (or no current highest)
    const result = await pool.query(
      `UPDATE ens_names
       SET highest_offer_wei = $1,
           highest_offer_id = $2,
           highest_offer_currency = $3,
           last_offer_update = NOW()
       WHERE id = $4
         AND (highest_offer_wei IS NULL OR highest_offer_wei::numeric < $1::numeric)
       RETURNING id, name`,
      [offerAmountWei, offerId, currencyAddress, ensNameId]
    );

    if (result.rows.length > 0) {
      logger.info(
        { ensNameId, name: result.rows[0].name, offerId, offerAmountWei },
        'Updated highest offer (new high)'
      );
    } else {
      logger.debug({ ensNameId, offerId }, 'Offer not higher than current highest, no update');
    }
  } catch (error) {
    logger.error({ error, ensNameId, offerId }, 'Failed to update highest offer');
    throw error;
  }
}

/**
 * Recalculate highest offer from all active offers
 * Called when an offer is removed (accepted, rejected, expired, cancelled)
 * O(n) operation where n = active offers for this name
 */
async function recalculateHighestOffer(data: RecalculateHighestOfferJob): Promise<void> {
  const { ensNameId } = data;

  try {
    // Find the highest active offer (pending status, not expired)
    const result = await pool.query(
      `SELECT
         o.id,
         o.offer_amount_wei,
         o.currency_address
       FROM offers o
       WHERE o.ens_name_id = $1
         AND o.status = 'pending'
         AND (o.currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' OR o.currency_address = '0x0000000000000000000000000000000000000000')
         AND (o.expires_at IS NULL OR o.expires_at > NOW())
       ORDER BY o.offer_amount_wei::numeric DESC
       LIMIT 1`,
      [ensNameId]
    );

    if (result.rows.length > 0) {
      // Found a new highest offer
      const highestOffer = result.rows[0];

      await pool.query(
        `UPDATE ens_names
         SET highest_offer_wei = $1,
             highest_offer_id = $2,
             highest_offer_currency = $3,
             last_offer_update = NOW()
         WHERE id = $4`,
        [
          highestOffer.offer_amount_wei,
          highestOffer.id,
          highestOffer.currency_address,
          ensNameId,
        ]
      );

      logger.info(
        { ensNameId, offerId: highestOffer.id, amount: highestOffer.offer_amount_wei },
        'Recalculated highest offer (new highest found)'
      );
    } else {
      // No active offers remaining - clear highest offer
      await pool.query(
        `UPDATE ens_names
         SET highest_offer_wei = NULL,
             highest_offer_id = NULL,
             highest_offer_currency = NULL,
             last_offer_update = NOW()
         WHERE id = $1`,
        [ensNameId]
      );

      logger.info({ ensNameId }, 'Cleared highest offer (no active offers)');
    }
  } catch (error) {
    logger.error({ error, ensNameId }, 'Failed to recalculate highest offer');
    throw error;
  }
}

/**
 * Register highest offer worker with pg-boss
 */
export async function registerHighestOfferWorker(boss: PgBoss): Promise<void> {
  // Worker 1: Update highest offer (optimistic - new offer might be higher)
  await boss.work<UpdateHighestOfferJob>(
    'update-highest-offer',
    { teamSize: 5, teamConcurrency: 2 },
    async (job) => {
      const { ensNameId, offerId, offerAmountWei, currencyAddress } = job.data;

      logger.debug(
        { ensNameId, offerId, offerAmountWei },
        'Processing update-highest-offer job'
      );

      await updateHighestOffer({
        ensNameId,
        offerId,
        offerAmountWei,
        currencyAddress,
      });
    }
  );

  logger.info('Registered update-highest-offer worker');

  // Worker 2: Recalculate highest offer (when offer removed)
  await boss.work<RecalculateHighestOfferJob>(
    'recalculate-highest-offer',
    { teamSize: 5, teamConcurrency: 2 },
    async (job) => {
      const { ensNameId } = job.data;

      logger.debug({ ensNameId }, 'Processing recalculate-highest-offer job');

      await recalculateHighestOffer({ ensNameId });
    }
  );

  logger.info('Registered recalculate-highest-offer worker');
}
