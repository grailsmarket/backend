import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';
import { QUEUE_NAMES, SyncEnsDataJob } from '../queue';
import { fetchENSMetadata } from '../services/blockchain';

/**
 * ENS Data Sync Worker
 *
 * Handles syncing ENS metadata from the blockchain
 * - Triggered when new listing created (immediate sync)
 * - Scheduled daily for all active listings
 */

/**
 * Register the ENS data sync worker
 */
export async function registerEnsSyncWorker(boss: PgBoss): Promise<void> {
  await boss.work<SyncEnsDataJob>(
    QUEUE_NAMES.SYNC_ENS_DATA,
    {
      teamSize: 3,
      teamConcurrency: 1,
    },
    async (job) => {
      const { ensNameId, nameHash, priority } = job.data;

      logger.info({ ensNameId, nameHash, priority }, 'Syncing ENS metadata');

      const pool = getPostgresPool();

      try {
        // Fetch metadata from blockchain
        const metadata = await fetchENSMetadata(nameHash);

        // Update database
        const result = await pool.query(
          `UPDATE ens_names
           SET metadata = $1,
               resolver_address = $2,
               updated_at = NOW()
           WHERE id = $3
           RETURNING id, name`,
          [JSON.stringify(metadata), metadata.resolverAddress || null, ensNameId]
        );

        if (result.rows.length > 0) {
          logger.info(
            { ensNameId, name: result.rows[0].name, metadata },
            'ENS metadata synced successfully'
          );
        } else {
          logger.warn({ ensNameId }, 'ENS name not found in database');
        }
      } catch (error) {
        logger.error({ error, ensNameId, nameHash }, 'Error syncing ENS metadata');
        throw error; // Will trigger pg-boss retry
      }
    }
  );

  logger.info('ENS sync worker registered');
}

/**
 * Register the daily ENS sync scheduler
 * Runs every day at 2 AM to refresh metadata for active listings
 */
export async function registerDailyEnsSyncScheduler(boss: PgBoss): Promise<void> {
  // Schedule the recurring daily job
  await boss.schedule(
    QUEUE_NAMES.SCHEDULE_DAILY_ENS_SYNC,
    '0 2 * * *' // 2 AM daily
  );

  // Register the worker to schedule individual sync jobs
  await boss.work(
    QUEUE_NAMES.SCHEDULE_DAILY_ENS_SYNC,
    async () => {
      logger.info('Running daily ENS sync scheduler');

      const pool = getPostgresPool();

      try {
        // Get all ENS names with active listings
        const result = await pool.query(`
          SELECT DISTINCT en.id, en.token_id
          FROM ens_names en
          JOIN listings l ON l.ens_name_id = en.id
          WHERE l.status = 'active'
        `);

        logger.info({ count: result.rows.length }, 'Scheduling ENS sync jobs for active listings');

        // Publish individual sync jobs
        const jobs = result.rows.map((row) => ({
          name: QUEUE_NAMES.SYNC_ENS_DATA,
          data: {
            ensNameId: row.id,
            nameHash: row.token_id,
            priority: 'normal' as const,
          },
        }));

        // Batch publish jobs (pg-boss can handle this efficiently)
        if (jobs.length > 0) {
          await boss.insert(jobs);
          logger.info({ jobsScheduled: jobs.length }, 'ENS sync jobs scheduled');
        }
      } catch (error) {
        logger.error({ error }, 'Error scheduling daily ENS sync');
        throw error;
      }
    }
  );

  logger.info('Daily ENS sync scheduler registered (runs at 2 AM daily)');
}
