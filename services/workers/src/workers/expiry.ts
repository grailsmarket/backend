import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, ExpireOrdersJob } from '../queue';

/**
 * Expiry Worker
 *
 * Handles two types of expiry jobs:
 * 1. Individual scheduled jobs - Expire specific listing/offer at exact time
 * 2. Batch expiry job - Safety net that runs every 5 minutes to catch any missed expirations
 */

/**
 * Register the individual expiry worker
 * Processes jobs scheduled to run at exact expires_at time
 */
export async function registerExpiryWorker(boss: PgBoss): Promise<void> {
  await boss.work<ExpireOrdersJob>(
    QUEUE_NAMES.EXPIRE_ORDERS,
    async (job) => {
      const { type, id } = job.data;

      logger.info({ type, id }, 'Processing expiry job');

      const pool = getPostgresPool();

      try {
        if (type === 'listing') {
          const result = await pool.query(
            `UPDATE listings
             SET status = 'expired', updated_at = NOW()
             WHERE id = $1
               AND status = 'active'
               AND expires_at <= NOW()
             RETURNING id, status, expires_at`,
            [id]
          );

          if (result.rows.length > 0) {
            logger.info({ listingId: id, row: result.rows[0] }, 'Listing expired successfully');
          } else {
            // Check if listing exists and why it wasn't updated
            const checkResult = await pool.query(
              'SELECT id, status, expires_at FROM listings WHERE id = $1',
              [id]
            );

            if (checkResult.rows.length === 0) {
              logger.warn({ listingId: id }, 'Listing not found');
            } else {
              const listing = checkResult.rows[0];
              logger.info(
                { listingId: id, status: listing.status, expiresAt: listing.expires_at },
                'Listing not expired - already in different status or not yet expired'
              );
            }
          }
        } else if (type === 'offer') {
          const result = await pool.query(
            `UPDATE offers
             SET status = 'expired'
             WHERE id = $1
               AND status = 'pending'
               AND expires_at <= NOW()
             RETURNING id, status, expires_at`,
            [id]
          );

          if (result.rows.length > 0) {
            logger.info({ offerId: id, row: result.rows[0] }, 'Offer expired successfully');
          } else {
            // Check if offer exists and why it wasn't updated
            const checkResult = await pool.query(
              'SELECT id, status, expires_at FROM offers WHERE id = $1',
              [id]
            );

            if (checkResult.rows.length === 0) {
              logger.warn({ offerId: id }, 'Offer not found');
            } else {
              const offer = checkResult.rows[0];
              logger.info(
                { offerId: id, status: offer.status, expiresAt: offer.expires_at },
                'Offer not expired - already in different status or not yet expired'
              );
            }
          }
        } else {
          logger.error({ type }, 'Unknown expiry type');
        }
      } catch (error) {
        logger.error({ error, type, id }, 'Error expiring order');
        throw error; // Will trigger pg-boss retry
      }
    }
  );

  logger.info('Expiry worker registered');
}

/**
 * Register the batch expiry worker (safety net)
 * Runs every 5 minutes to catch any missed individual jobs
 */
export async function registerBatchExpiryWorker(boss: PgBoss): Promise<void> {
  // Schedule the recurring batch job
  await boss.schedule(
    QUEUE_NAMES.BATCH_EXPIRE_ORDERS,
    '*/5 * * * *' // Every 5 minutes
  );

  // Register the worker to process batch jobs
  await boss.work(
    QUEUE_NAMES.BATCH_EXPIRE_ORDERS,
    async () => {
      logger.info('Running batch expiry check');

      const pool = getPostgresPool();

      try {
        let totalExpiredListings = 0;
        let totalExpiredOffers = 0;

        // Process in batches of 50 to avoid pg_notify payload limit (8000 bytes)
        const BATCH_SIZE = 50;

        // Expire overdue listings in batches
        while (true) {
          const listingsResult = await pool.query(
            `UPDATE listings
             SET status = 'expired', updated_at = NOW()
             WHERE id IN (
               SELECT id FROM listings
               WHERE status = 'active'
                 AND expires_at IS NOT NULL
                 AND expires_at <= NOW()
               LIMIT $1
             )
             RETURNING id`,
            [BATCH_SIZE]
          );

          totalExpiredListings += listingsResult.rows.length;

          if (listingsResult.rows.length < BATCH_SIZE) {
            break; // No more listings to expire
          }
        }

        // Expire overdue offers in batches
        while (true) {
          const offersResult = await pool.query(
            `UPDATE offers
             SET status = 'expired'
             WHERE id IN (
               SELECT id FROM offers
               WHERE status = 'pending'
                 AND expires_at IS NOT NULL
                 AND expires_at <= NOW()
               LIMIT $1
             )
             RETURNING id`,
            [BATCH_SIZE]
          );

          totalExpiredOffers += offersResult.rows.length;

          if (offersResult.rows.length < BATCH_SIZE) {
            break; // No more offers to expire
          }
        }

        if (totalExpiredListings > 0 || totalExpiredOffers > 0) {
          logger.info(
            { expiredListings: totalExpiredListings, expiredOffers: totalExpiredOffers },
            'Batch expiry completed - found overdue orders'
          );
        } else {
          logger.debug('Batch expiry completed - no overdue orders found');
        }
      } catch (error) {
        logger.error({ error }, 'Error in batch expiry job');
        throw error;
      }
    }
  );

  logger.info('Batch expiry worker registered (runs every 5 minutes)');
}
