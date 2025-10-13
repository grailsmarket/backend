import PgBoss from 'pg-boss';
import { config } from '../../shared/src';
import { logger } from './utils/logger';

let boss: PgBoss | null = null;

export interface QueueConfig {
  connectionString: string;
  schema?: string;
  max?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInHours?: number;
  archiveCompletedAfterSeconds?: number;
}

const defaultConfig: Partial<QueueConfig> = {
  schema: 'pgboss',
  max: 10,
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInHours: 24,
  archiveCompletedAfterSeconds: 60 * 60 * 24 * 7, // 7 days
};

export async function getQueueClient(customConfig?: Partial<QueueConfig>): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  const queueConfig: QueueConfig = {
    connectionString: config.database.url,
    ...defaultConfig,
    ...customConfig,
  };

  boss = new PgBoss(queueConfig);

  boss.on('error', (error) => {
    logger.error({ error }, 'pg-boss error');
  });

  boss.on('monitor-states', (states) => {
    logger.debug({ states }, 'Queue metrics');
  });

  await boss.start();
  logger.info('pg-boss queue client started');

  return boss;
}

export async function closeQueueClient(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    logger.info('pg-boss queue client stopped');
  }
}

// Job type definitions
export interface ExpireOrdersJob {
  type: 'listing' | 'offer';
  id: number;
}

export interface SyncEnsDataJob {
  ensNameId: number;
  nameHash: string;
  priority: 'high' | 'normal';
}

export interface UpdateOwnershipJob {
  ensNameId: number;
  newOwner: string;
  blockNumber: number;
  transactionHash: string;
}

export interface SendNotificationJob {
  type: 'new-listing' | 'price-change' | 'sale' | 'new-offer' | 'listing-cancelled-ownership-change';
  userId?: number;
  email?: string;
  recipientAddress?: string;
  ensNameId: number;
  metadata?: Record<string, any>;
  transactionHash?: string;
}

// Queue names as constants
export const QUEUE_NAMES = {
  EXPIRE_ORDERS: 'expire-orders',
  BATCH_EXPIRE_ORDERS: 'batch-expire-orders',
  SYNC_ENS_DATA: 'sync-ens-data',
  SCHEDULE_DAILY_ENS_SYNC: 'schedule-daily-ens-sync',
  BATCH_RESOLVE_NAMES: 'batch-resolve-names',
  UPDATE_OWNERSHIP: 'update-ownership',
  SEND_NOTIFICATION: 'send-notification',
} as const;
