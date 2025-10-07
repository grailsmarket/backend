import { config, getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../shared/src';
import { ElasticsearchSync } from './services/elasticsearch-sync';
import { WALListener } from './services/wal-listener';
import { logger } from './utils/logger';

async function start() {
  logger.info('Starting WAL listener service...');

  const pool = getPostgresPool();
  const esClient = getElasticsearchClient();

  try {
    await pool.query('SELECT 1');
    logger.info('Database connection established');

    await esClient.ping();
    logger.info('Elasticsearch connection established');
  } catch (error) {
    logger.error('Failed to establish connections:', error);
    process.exit(1);
  }

  const esSync = new ElasticsearchSync();
  const walListener = new WALListener(esSync);

  try {
    await esSync.createIndex();

    // Start the WAL listener (it will handle CDC setup internally)
    await walListener.start();

    logger.info('WAL listener started successfully');
  } catch (error: any) {
    logger.error('Failed to start WAL listener:', error?.message || error);
    if (error?.stack) {
      logger.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await walListener.stop();
    await closeAllConnections();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await walListener.stop();
    await closeAllConnections();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

start().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});