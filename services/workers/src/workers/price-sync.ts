import PgBoss from 'pg-boss';
import { PriceFetcher } from '../services/price-fetcher';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'fetch-eth-price';
const CRON_SCHEDULE = '*/5 * * * *'; // Every 5 minutes

/**
 * Worker that fetches and stores ETH price from CoinGecko
 * Runs every 5 minutes
 */
export async function registerPriceSyncWorker(boss: PgBoss) {
  const fetcher = new PriceFetcher();

  // Register the worker to process price fetch jobs
  await boss.work(
    QUEUE_NAME,
    {
      teamSize: 1, // Only need one worker
      teamConcurrency: 1, // Process one at a time
    },
    async (job) => {
      logger.info({ jobId: job.id }, 'Starting ETH price fetch job');

      try {
        const price = await fetcher.fetchAndStoreEthPrice();

        logger.info({ jobId: job.id, price }, 'ETH price fetch job completed successfully');

        return { success: true, price };
      } catch (error: any) {
        logger.error({ jobId: job.id, error: error.message }, 'ETH price fetch job failed');
        throw error; // Will trigger retry
      }
    }
  );

  logger.info({ queue: QUEUE_NAME, schedule: CRON_SCHEDULE }, 'Price sync worker registered');

  // Schedule recurring job (every 5 minutes)
  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, {
    tz: 'UTC',
  });

  logger.info({ queue: QUEUE_NAME, schedule: CRON_SCHEDULE }, 'Price sync cron job scheduled');

  // Fetch immediately on startup (don't wait 5 minutes)
  try {
    logger.info('Fetching ETH price immediately on startup...');
    await fetcher.fetchAndStoreEthPrice();

    // Log current stats
    const stats = await fetcher.getPriceStats();
    logger.info(
      {
        priceCount: stats.count,
        oldestPrice: stats.oldest,
        newestPrice: stats.newest,
        currentPrice: stats.latestPrice,
      },
      'Price feed statistics'
    );
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to fetch initial ETH price on startup');
    // Don't crash the worker service, it will retry in 5 minutes
  }
}
