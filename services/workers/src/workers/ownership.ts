import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, UpdateOwnershipJob } from '../queue';

/**
 * Ownership Update Worker
 *
 * Handles ownership changes detected by the indexer
 * - Updates owner_address in ens_names table
 * - Cancels any active listings (ownership changed = listings invalid)
 * - Publishes notification jobs for cancelled listings
 */

export async function registerOwnershipWorker(boss: PgBoss): Promise<void> {
  await boss.work<UpdateOwnershipJob>(
    QUEUE_NAMES.UPDATE_OWNERSHIP,
    {
      teamSize: 3,
      teamConcurrency: 1,
    },
    async (job) => {
      const { ensNameId, newOwner, blockNumber, transactionHash } = job.data;

      logger.info(
        { ensNameId, newOwner, blockNumber, transactionHash },
        'Processing ownership update'
      );

      const pool = getPostgresPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Get current ownership info
        const currentResult = await client.query(
          'SELECT id, name, owner_address FROM ens_names WHERE id = $1',
          [ensNameId]
        );

        if (currentResult.rows.length === 0) {
          logger.warn({ ensNameId }, 'ENS name not found in database');
          await client.query('ROLLBACK');
          return;
        }

        const currentOwner = currentResult.rows[0].owner_address;
        const ensName = currentResult.rows[0].name;

        // Check if ownership actually changed (idempotency)
        if (currentOwner.toLowerCase() === newOwner.toLowerCase()) {
          logger.info(
            { ensNameId, ensName, owner: newOwner },
            'Ownership already up to date, skipping'
          );
          await client.query('ROLLBACK');
          return;
        }

        // Update ownership
        await client.query(
          `UPDATE ens_names
           SET owner_address = $1,
               last_transfer_date = NOW(),
               updated_at = NOW()
           WHERE id = $2`,
          [newOwner.toLowerCase(), ensNameId]
        );

        logger.info(
          { ensNameId, ensName, oldOwner: currentOwner, newOwner },
          'Ownership updated'
        );

        // Cancel any active listings (ownership changed = seller can't fulfill)
        const cancelledListings = await client.query(
          `UPDATE listings
           SET status = 'cancelled', updated_at = NOW()
           WHERE ens_name_id = $1
             AND status = 'active'
           RETURNING id, seller_address, price_wei`,
          [ensNameId]
        );

        if (cancelledListings.rows.length > 0) {
          logger.info(
            { ensNameId, ensName, count: cancelledListings.rows.length },
            'Cancelled active listings due to ownership change'
          );

          // Publish notification jobs for each cancelled listing
          const notificationJobs = cancelledListings.rows.map((listing) => ({
            name: QUEUE_NAMES.SEND_NOTIFICATION,
            data: {
              type: 'listing-cancelled-ownership-change' as const,
              recipientAddress: listing.seller_address,
              ensNameId,
              metadata: {
                listingId: listing.id,
                priceWei: listing.price_wei,
                oldOwner: currentOwner,
                newOwner,
              },
              transactionHash,
            },
          }));

          if (notificationJobs.length > 0) {
            await boss.insert(notificationJobs);
            logger.info(
              { count: notificationJobs.length },
              'Notification jobs published for cancelled listings'
            );
          }
        }

        await client.query('COMMIT');
        logger.info({ ensNameId, ensName }, 'Ownership update transaction completed');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error({ error, ensNameId, newOwner }, 'Error updating ownership');
        throw error; // Will trigger pg-boss retry
      } finally {
        client.release();
      }
    }
  );

  logger.info('Ownership worker registered');
}
