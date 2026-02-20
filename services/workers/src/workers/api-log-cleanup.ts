import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'cleanup-api-request-logs';
const CRON_SCHEDULE = '0 4 * * 0'; // Every Sunday at 4 AM UTC

export async function registerApiLogCleanupWorker(boss: PgBoss) {
  await boss.work(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      logger.info({ jobId: job.id }, 'Starting API request logs cleanup');

      try {
        const pool = getPostgresPool();
        const result = await pool.query(
          `DELETE FROM api_request_logs WHERE created_at < NOW() - INTERVAL '90 days'`,
        );

        const deletedCount = result.rowCount ?? 0;
        logger.info(
          { jobId: job.id, deletedCount },
          'API request logs cleanup completed',
        );

        return { success: true, deletedCount };
      } catch (error) {
        logger.error({ jobId: job.id, err: error }, 'API request logs cleanup failed');
        throw error;
      }
    },
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE },
    'API log cleanup worker registered (weekly, Sunday 4 AM UTC)',
  );
}
