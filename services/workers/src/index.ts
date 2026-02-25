import { getQueueClient, closeQueueClient } from './queue';
import { registerExpiryWorker, registerBatchExpiryWorker } from './workers/expiry';
import { registerEnsSyncWorker, registerDailyEnsSyncScheduler, registerMetadataBackfillScheduler } from './workers/ens-sync';
import { registerBatchNameResolutionWorker } from './workers/name-resolution';
import { registerOwnershipWorker } from './workers/ownership';
import { registerNotificationWorker } from './workers/notifications';
import { registerPriceSyncWorker } from './workers/price-sync';
import { registerVerificationWorker } from './workers/verification';
import { registerClubStatsWorker } from './workers/club-stats';
import { registerHighestOfferWorker } from './workers/highest-offer';
import { refreshAnalytics, scheduleAnalyticsRefresh } from './workers/refresh-analytics';
import { registerValidationWorkers, registerValidationSchedulers } from './workers/validation';
import { registerReconcileOpenseaWorker } from './workers/reconcile-opensea';
import { registerAiCacheCleanupWorker } from './workers/ai-cache-cleanup';
import { registerOnchainActivityWorker } from './workers/onchain-activity';
import { registerApiLogCleanupWorker } from './workers/api-log-cleanup';
import { registerPersonaClassificationWorker } from './workers/persona-classification';
import { registerGoogleMetricsBackfillWorker } from './workers/google-metrics-backfill';
import { logger } from './utils/logger';
import { closeAllConnections } from '../../shared/src';

async function start() {
  logger.info('Starting Grails worker service...');

  try {
    // Initialize pg-boss
    const boss = await getQueueClient();

    // Register all workers
    logger.info('Registering workers...');

    await registerExpiryWorker(boss);
    await registerBatchExpiryWorker(boss);
    await registerEnsSyncWorker(boss);
    await registerDailyEnsSyncScheduler(boss);
    await registerMetadataBackfillScheduler(boss);
    await registerBatchNameResolutionWorker(boss);
    await registerOwnershipWorker(boss);
    await registerNotificationWorker(boss);
    await registerPriceSyncWorker(boss);
    await registerVerificationWorker(boss);
    await registerClubStatsWorker(boss);
    await registerHighestOfferWorker(boss);

    // Register validation workers and schedulers
    await registerValidationWorkers(boss);
    await registerValidationSchedulers(boss);

    // Register analytics refresh worker
    await boss.work('refresh-analytics', refreshAnalytics);
    await scheduleAnalyticsRefresh(boss);

    // Register OpenSea reconciliation worker
    await registerReconcileOpenseaWorker(boss);

    // Register AI recommendations cache cleanup worker
    await registerAiCacheCleanupWorker(boss);

    // Register onchain activity and API log cleanup workers
    await registerOnchainActivityWorker(boss);
    await registerApiLogCleanupWorker(boss);

    // Register persona classification worker
    await registerPersonaClassificationWorker(boss);

    // Register Google metrics backfill worker
    await registerGoogleMetricsBackfillWorker(boss);

    logger.info('All workers registered successfully');
    logger.info('Worker service is now processing jobs');

    // Log queue statistics every 60 seconds
    setInterval(async () => {
      try {
        const queueSize = await boss.getQueueSize('expire-orders');
        logger.info({ queueSize }, 'Queue statistics');
      } catch (error) {
        logger.error({ error }, 'Error fetching queue statistics');
      }
    }, 60000);

  } catch (error) {
    logger.error({ error }, 'Failed to start worker service');
    process.exit(1);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, shutting down gracefully...');

    try {
      await closeQueueClient();
      await closeAllConnections();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled rejection');
    process.exit(1);
  });
}

start().catch((error) => {
  logger.error({ error }, 'Fatal error during startup');
  process.exit(1);
});
