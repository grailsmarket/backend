import PgBoss from 'pg-boss';
import { config } from '../../shared/src';
import { logger } from './utils/logger';

let boss: PgBoss | null = null;
let isStarting = false;
let startPromise: Promise<PgBoss> | null = null;

interface QueueJobOptions {
  singletonKey?: string;
  singletonSeconds?: number;
}

/**
 * Get or create the queue client for publishing jobs
 * This is a lightweight client - it only publishes, doesn't consume
 *
 * IMPORTANT: Always use this singleton instead of creating new PgBoss instances.
 * Creating inline instances causes connection pool exhaustion.
 */
export async function getQueueClient(): Promise<PgBoss> {
  // If already started and ready, return immediately
  if (boss) {
    return boss;
  }

  // If currently starting, wait for the existing start operation
  if (isStarting && startPromise) {
    return startPromise;
  }

  // Start the initialization process
  isStarting = true;
  startPromise = (async () => {
    try {
      const newBoss = new PgBoss({
        connectionString: config.database.url,
        schema: 'pgboss',
        // Publisher-only optimizations:
        // - noSupervisor: Disables maintenance workers that poll the database
        // - max: Limit connection pool size (we only need a few for publishing)
        noSupervisor: true,
        max: 3,
      });

      newBoss.on('error', (error: any) => {
        // Log but don't crash - transient connection errors are recoverable
        logger.error({
          errorMessage: error?.message || String(error),
          errorStack: error?.stack,
          errorCode: error?.code
        }, 'pg-boss error in indexer service (non-fatal)');
      });

      // Start pg-boss and wait for it to be ready
      await newBoss.start();

      // Wait a bit to ensure internal initialization is complete
      // This gives pg-boss time to set up its queue cache
      await new Promise(resolve => setTimeout(resolve, 100));

      logger.info('pg-boss queue client started (publisher only, noSupervisor mode)');

      boss = newBoss;
      return boss;
    } finally {
      isStarting = false;
      startPromise = null;
    }
  })();

  return startPromise;
}

/**
 * Safely publish a job to the queue.
 * Handles connection errors gracefully without crashing the service.
 */
export async function safePublishJob(
  queueName: string,
  data: Record<string, any>,
  context?: string,
  options?: QueueJobOptions,
): Promise<boolean> {
  try {
    const client = await getQueueClient();
    if (options) {
      await client.send(queueName, data, options as any);
    } else {
      await client.send(queueName, data);
    }
    return true;
  } catch (error: any) {
    logger.error({
      queueName,
      context,
      errorMessage: error?.message || String(error),
      errorCode: error?.code,
    }, 'Failed to publish job to queue (non-fatal)');
    return false;
  }
}

export async function closeQueueClient(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 5000 });
    boss = null;
    logger.info('pg-boss queue client stopped');
  }
}

// Queue names - keep in sync with workers service
export const QUEUE_NAMES = {
  UPDATE_OWNERSHIP: 'update-ownership',
  UPDATE_CLUB_FLOOR_PRICE: 'update-club-floor-price',
  UPDATE_CLUB_SALES_STATS: 'update-club-sales-stats',
  UPDATE_HIGHEST_OFFER: 'update-highest-offer',
  INVALIDATE_ENS_METADATA_CACHE: 'invalidate-ens-metadata-cache',
} as const;
