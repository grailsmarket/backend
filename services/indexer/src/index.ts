import { config, getPostgresPool, closeAllConnections } from '../../shared/src';
import { ENSIndexer } from './indexers/ens-indexer';
import { SeaportIndexer } from './indexers/seaport-indexer';
import { OpenSeaStreamListener } from './services/opensea-stream';
import { logger } from './utils/logger';

async function start() {
  logger.info('Starting blockchain indexer service...');

  // Check RPC URL configuration
  if (!config.blockchain.rpcUrl || config.blockchain.rpcUrl.includes('YOUR_')) {
    logger.error('RPC_URL is not configured properly. Please set a valid RPC URL in your .env file');
    logger.info('You can get a free RPC URL from:');
    logger.info('  - Infura: https://infura.io');
    logger.info('  - Alchemy: https://www.alchemy.com');
    logger.info('  - QuickNode: https://www.quicknode.com');
    process.exit(1);
  }

  const pool = getPostgresPool();

  try {
    await pool.query('SELECT 1');
    logger.info('Database connection established');
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    process.exit(1);
  }

  const ensIndexer = new ENSIndexer();
  const seaportIndexer = new SeaportIndexer();
  const openSeaStream = new OpenSeaStreamListener();

  try {
    logger.info('Starting ENS indexer...');
    await ensIndexer.start();
    logger.info('ENS indexer started successfully');

    logger.info('Starting Seaport indexer...');
    await seaportIndexer.start();
    logger.info('Seaport indexer started successfully');

    if (config.opensea.apiKey) {
      logger.info('Starting OpenSea stream...');
      await openSeaStream.start();
      logger.info('OpenSea stream started successfully');
    }

    logger.info('All indexers started successfully');
  } catch (error: any) {
    logger.error('Failed to start indexers:', error?.message || error);
    if (error?.stack) {
      logger.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await ensIndexer.stop();
    await seaportIndexer.stop();
    await openSeaStream.stop();
    await closeAllConnections();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await ensIndexer.stop();
    await seaportIndexer.stop();
    await openSeaStream.stop();
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