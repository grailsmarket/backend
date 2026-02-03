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
        // Get ENS names with active listings, offers, recent views, or on watchlists
        const result = await pool.query(`
          SELECT DISTINCT en.id, en.token_id
          FROM ens_names en
          WHERE
            -- Active listings
            EXISTS (SELECT 1 FROM listings l WHERE l.ens_name_id = en.id AND l.status = 'active')
            -- Active offers
            OR EXISTS (SELECT 1 FROM offers o WHERE o.ens_name_id = en.id AND o.status = 'active')
            -- Recently viewed (last 7 days)
            OR EXISTS (SELECT 1 FROM name_views nv WHERE nv.ens_name_id = en.id AND nv.viewed_at > NOW() - INTERVAL '7 days')
            -- On any watchlist
            OR EXISTS (SELECT 1 FROM watchlist w WHERE w.ens_name_id = en.id)
        `);

        logger.info({ count: result.rows.length }, 'Scheduling ENS sync jobs (listings, offers, views, watchlist)');

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

/**
 * Register the weekly metadata backfill scheduler
 * Runs every Sunday at 3 AM to catch up names with empty metadata
 */
export async function registerMetadataBackfillScheduler(boss: PgBoss): Promise<void> {
  // Schedule the recurring weekly job
  await boss.schedule(
    QUEUE_NAMES.SCHEDULE_METADATA_BACKFILL,
    '0 3 * * 0' // 3 AM every Sunday
  );

  // Register the worker to schedule individual sync jobs
  await boss.work(
    QUEUE_NAMES.SCHEDULE_METADATA_BACKFILL,
    async () => {
      logger.info('Running weekly metadata backfill scheduler');

      const pool = getPostgresPool();

      try {
        // Get names with empty metadata (limit to prevent overwhelming)
        const result = await pool.query(`
          SELECT id, token_id
          FROM ens_names
          WHERE metadata = '{}'::jsonb
            AND token_id IS NOT NULL
          ORDER BY updated_at ASC
          LIMIT 5000
        `);

        logger.info({ count: result.rows.length }, 'Scheduling metadata backfill jobs for names with empty metadata');

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
          logger.info({ jobsScheduled: jobs.length }, 'Metadata backfill jobs scheduled');
        }
      } catch (error) {
        logger.error({ error }, 'Error scheduling metadata backfill');
        throw error;
      }
    }
  );

  logger.info('Metadata backfill scheduler registered (runs at 3 AM every Sunday)');
}
