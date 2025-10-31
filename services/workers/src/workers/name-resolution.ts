import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES } from '../queue';
import { resolveTokenIdToName } from '../services/blockchain';

/**
 * Batch Name Resolution Worker
 *
 * Runs every 5 minutes to find ENS names with placeholder token-# names
 * and resolves them to actual .eth names using The Graph
 */

/**
 * Register the batch name resolution worker
 * Runs every 5 minutes to resolve placeholder names
 */
export async function registerBatchNameResolutionWorker(boss: PgBoss): Promise<void> {
  // Schedule the recurring batch job
  await boss.schedule(
    QUEUE_NAMES.BATCH_RESOLVE_NAMES,
    '*/5 * * * *' // Every 5 minutes
  );

  // Register the worker to process batch jobs
  await boss.work(
    QUEUE_NAMES.BATCH_RESOLVE_NAMES,
    async () => {
      logger.info('Running batch name resolution check');

      const pool = getPostgresPool();

      try {
        // Find ENS names with placeholder names (limit to avoid overwhelming The Graph)
        const BATCH_SIZE = 20; // Process 20 at a time to respect rate limits

        const result = await pool.query(
          `SELECT id, token_id, name
           FROM ens_names
           WHERE name LIKE 'token-%' OR name LIKE '#%'
           ORDER BY created_at DESC
           LIMIT $1`,
          [BATCH_SIZE]
        );

        if (result.rows.length === 0) {
          logger.debug('No placeholder names found to resolve');
          return;
        }

        logger.info({ count: result.rows.length }, 'Found placeholder names to resolve');

        let resolved = 0;
        let failed = 0;

        // Process each name
        for (const row of result.rows) {
          try {
            const actualName = await resolveTokenIdToName(row.token_id);

            if (actualName) {
              // Update the name in the database
              await pool.query(
                `UPDATE ens_names
                 SET name = $1, updated_at = NOW()
                 WHERE id = $2`,
                [actualName, row.id]
              );

              logger.info(
                { id: row.id, tokenId: row.token_id, oldName: row.name, newName: actualName },
                'Resolved placeholder name to actual ENS name'
              );

              resolved++;
            } else {
              logger.debug(
                { id: row.id, tokenId: row.token_id },
                'Could not resolve name - may not be registered yet'
              );
              failed++;
            }

            // Add a small delay between requests to respect rate limits
            await new Promise(resolve => setTimeout(resolve, 100));

          } catch (error) {
            logger.error(
              { error, id: row.id, tokenId: row.token_id },
              'Error resolving individual name'
            );
            failed++;
          }
        }

        logger.info(
          { totalProcessed: result.rows.length, resolved, failed },
          'Batch name resolution completed'
        );

      } catch (error) {
        logger.error({ error }, 'Error in batch name resolution job');
        throw error;
      }
    }
  );

  logger.info('Batch name resolution worker registered (runs every 5 minutes)');
}
