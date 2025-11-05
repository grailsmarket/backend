import { Job } from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Refresh Analytics Materialized Views Worker
 *
 * This worker refreshes all materialized views used for analytics and trending features.
 * It should be scheduled to run periodically (e.g., every 15 minutes).
 *
 * Refreshes:
 * - trending_views_24h / trending_views_7d
 * - trending_watchlist_24h / trending_watchlist_7d
 * - trending_votes_24h / trending_votes_7d
 * - trending_sales_24h / trending_sales_7d
 * - trending_offers_24h / trending_offers_7d
 * - trending_composite_24h / trending_composite_7d
 */

interface RefreshAnalyticsJob {
  view?: string; // Optional: specific view to refresh, otherwise refreshes all
}

export async function refreshAnalytics(job: Job<RefreshAnalyticsJob>): Promise<void> {
  const pool = getPostgresPool();
  const { view } = job.data;

  try {
    if (view) {
      // Refresh specific view
      logger.info({ view }, 'Refreshing specific analytics materialized view');
      await refreshView(view);
      logger.info({ view }, 'Successfully refreshed analytics view');
    } else {
      // Refresh all views
      logger.info('Refreshing all analytics materialized views');

      const views = [
        'trending_views_24h',
        'trending_views_7d',
        'trending_watchlist_24h',
        'trending_watchlist_7d',
        'trending_votes_24h',
        'trending_votes_7d',
        'trending_sales_24h',
        'trending_sales_7d',
        'trending_offers_24h',
        'trending_offers_7d',
        'trending_composite_24h',
        'trending_composite_7d',
      ];

      const startTime = Date.now();

      // Refresh views in parallel for speed
      await Promise.all(views.map(viewName => refreshView(viewName)));

      const duration = Date.now() - startTime;
      logger.info(
        { duration, viewCount: views.length },
        'Successfully refreshed all analytics materialized views'
      );
    }
  } catch (error: any) {
    logger.error(
      { error: error.message, stack: error.stack, view },
      'Failed to refresh analytics materialized views'
    );
    throw error; // Re-throw to let pg-boss handle retry logic
  }
}

async function refreshView(viewName: string): Promise<void> {
  const pool = getPostgresPool();

  const startTime = Date.now();

  try {
    // Use CONCURRENTLY to allow queries while refreshing (Postgres 9.4+)
    // This prevents blocking reads during refresh
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);

    const duration = Date.now() - startTime;
    logger.debug(
      { viewName, duration },
      'Refreshed materialized view'
    );
  } catch (error: any) {
    // If CONCURRENTLY fails (usually because of missing UNIQUE index),
    // fall back to blocking refresh
    if (error.message.includes('CONCURRENTLY') || error.message.includes('unique index')) {
      logger.warn(
        { viewName },
        'CONCURRENTLY refresh failed, falling back to blocking refresh'
      );

      await pool.query(`REFRESH MATERIALIZED VIEW ${viewName}`);

      const duration = Date.now() - startTime;
      logger.debug(
        { viewName, duration, concurrent: false },
        'Refreshed materialized view (blocking)'
      );
    } else {
      throw error;
    }
  }
}

/**
 * Schedule recurring refresh job
 * Call this on worker startup to set up the schedule
 */
export async function scheduleAnalyticsRefresh(boss: any): Promise<void> {
  // Schedule refresh every 15 minutes
  await boss.schedule(
    'refresh-analytics',
    '*/15 * * * *', // Cron: every 15 minutes
    {},
    {
      tz: 'UTC',
    }
  );

  logger.info('Scheduled analytics refresh job to run every 15 minutes');
}
