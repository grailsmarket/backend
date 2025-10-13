import PgBoss from 'pg-boss';
import { config } from '../../shared/src';
import { logger } from './utils/logger';

let boss: PgBoss | null = null;
let isStarting = false;
let startPromise: Promise<PgBoss> | null = null;

/**
 * Get or create the queue client for publishing jobs
 * This is a lightweight client - it only publishes, doesn't consume
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
      });

      newBoss.on('error', (error: any) => {
        logger.error({
          errorMessage: error?.message || String(error),
          errorStack: error?.stack,
          errorCode: error?.code
        }, 'pg-boss error in indexer service');
      });

      // Start pg-boss and wait for it to be ready
      await newBoss.start();

      // Wait a bit to ensure internal initialization is complete
      // This gives pg-boss time to set up its queue cache
      await new Promise(resolve => setTimeout(resolve, 100));

      logger.info('pg-boss queue client started (publisher only)');

      boss = newBoss;
      return boss;
    } finally {
      isStarting = false;
      startPromise = null;
    }
  })();

  return startPromise;
}

export async function closeQueueClient(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 5000 });
    boss = null;
    logger.info('pg-boss queue client stopped');
  }
}

// Queue names (imported from worker service for consistency)
export const QUEUE_NAMES = {
  UPDATE_OWNERSHIP: 'update-ownership',
} as const;
