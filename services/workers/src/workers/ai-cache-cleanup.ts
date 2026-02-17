import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'cleanup-ai-recommendations';
const CRON_SCHEDULE = '0 3 * * 0'; // Every Sunday at 3 AM UTC

/**
 * Worker that deletes expired AI recommendation cache rows.
 * Runs weekly to prevent unbounded table growth from stale entries
 * that are never re-requested.
 */
export async function registerAiCacheCleanupWorker(boss: PgBoss) {
  await boss.work(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      logger.info({ jobId: job.id }, 'Starting AI recommendations cache cleanup');

      const pool = getPostgresPool();
      const result = await pool.query(
        `DELETE FROM ai_recommendations WHERE expires_at < NOW()`
      );

      const deletedCount = result.rowCount ?? 0;
      logger.info(
        { jobId: job.id, deletedCount },
        'AI recommendations cache cleanup completed'
      );

      return { success: true, deletedCount };
    }
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE },
    'AI cache cleanup worker registered (weekly, Sunday 3 AM UTC)'
  );
}
