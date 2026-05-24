import PgBoss from 'pg-boss';
import { config } from '../../shared/src';
import { logger } from './utils/logger';

let boss: PgBoss | null = null;

/**
 * Get or create the queue client for publishing jobs
 * This is a lightweight client - it only publishes, doesn't consume
 *
 * IMPORTANT: Always use this singleton instead of creating new PgBoss instances.
 * Creating inline instances causes connection pool exhaustion.
 */
export async function getQueueClient(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  boss = new PgBoss({
    connectionString: config.database.url,
    schema: 'pgboss',
    // Publisher-only optimizations:
    // - noSupervisor: Disables maintenance workers that poll the database
    // - max: Limit connection pool size (we only need a few for publishing)
    noSupervisor: true,
    max: 3,
  });

  boss.on('error', (error) => {
    // Log but don't crash - transient connection errors are recoverable
    logger.error({ error }, 'pg-boss error in WAL listener service (non-fatal)');
  });

  await boss.start();
  logger.info('pg-boss queue client started (publisher only, noSupervisor mode)');

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
  INVALIDATE_ENS_METADATA_CACHE: 'invalidate-ens-metadata-cache',
} as const;
