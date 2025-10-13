import PgBoss from 'pg-boss';
import { config } from '../../shared/src';
import { logger } from './utils/logger';

let boss: PgBoss | null = null;

/**
 * Get or create the queue client for publishing jobs
 * This is a lightweight client - it only publishes, doesn't consume
 */
export async function getQueueClient(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  boss = new PgBoss({
    connectionString: config.database.url,
    schema: 'pgboss',
  });

  boss.on('error', (error) => {
    logger.error({ error }, 'pg-boss error in WAL listener service');
  });

  await boss.start();
  logger.info('pg-boss queue client started (publisher only)');

  return boss;
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
  SEND_NOTIFICATION: 'send-notification',
} as const;
