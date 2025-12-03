/**
 * Bootstrap Validation Script
 *
 * One-time script to validate all existing listings and offers when the validation
 * system is first deployed. This will:
 * 1. Queue validation jobs for all active listings
 * 2. Queue batch validation jobs for all pending offers
 * 3. Provides progress reporting and statistics
 *
 * Usage:
 *   npm run script:bootstrap-validation
 *
 * Environment Variables:
 *   LISTING_BATCH_SIZE - Number of listings to validate per batch (default: 100)
 *   OFFER_BATCH_SIZE - Number of offers to validate per batch (default: 200)
 */

import { getPostgresPool } from '../../../shared/src';
import { getQueueClient } from '../queue';
import { logger } from '../utils/logger';

const pool = getPostgresPool();

interface Stats {
  totalListings: number;
  listingsQueued: number;
  totalOffers: number;
  offersQueued: number;
  startTime: Date;
  endTime?: Date;
}

async function main() {
  const stats: Stats = {
    totalListings: 0,
    listingsQueued: 0,
    totalOffers: 0,
    offersQueued: 0,
    startTime: new Date(),
  };

  logger.info('Starting bootstrap validation...');

  try {
    const boss = await getQueueClient();

    // ============================================================================
    // Part 1: Validate all active listings
    // ============================================================================
    logger.info('Fetching active listings...');

    const listingsResult = await pool.query(`
      SELECT id
      FROM listings
      WHERE status = 'active'
      ORDER BY id
    `);

    stats.totalListings = listingsResult.rows.length;
    logger.info({ count: stats.totalListings }, 'Found active listings to validate');

    if (stats.totalListings > 0) {
      const LISTING_BATCH_SIZE = parseInt(process.env.LISTING_BATCH_SIZE || '100', 10);

      for (let i = 0; i < listingsResult.rows.length; i += LISTING_BATCH_SIZE) {
        const batch = listingsResult.rows.slice(i, i + LISTING_BATCH_SIZE);
        const jobs = batch.map(row => ({
          name: 'validate-listing-ownership',
          data: { listingId: row.id }
        }));

        await boss.insert(jobs);
        stats.listingsQueued += jobs.length;

        logger.info({
          queued: stats.listingsQueued,
          total: stats.totalListings,
          percent: Math.round((stats.listingsQueued / stats.totalListings) * 100)
        }, 'Listing validation progress');
      }

      logger.info(
        { queued: stats.listingsQueued, total: stats.totalListings },
        'All listing validation jobs queued'
      );
    }

    // ============================================================================
    // Part 2: Validate all pending offers in batches
    // ============================================================================
    logger.info('Fetching pending offers...');

    const offersResult = await pool.query(`
      SELECT id
      FROM offers
      WHERE status = 'pending'
      ORDER BY id
    `);

    stats.totalOffers = offersResult.rows.length;
    logger.info({ count: stats.totalOffers }, 'Found pending offers to validate');

    if (stats.totalOffers > 0) {
      const OFFER_BATCH_SIZE = parseInt(process.env.OFFER_BATCH_SIZE || '200', 10);

      for (let i = 0; i < offersResult.rows.length; i += OFFER_BATCH_SIZE) {
        const batch = offersResult.rows.slice(i, i + OFFER_BATCH_SIZE);
        const offerIds = batch.map(row => row.id);

        // Use batch validation for efficiency
        await boss.send('batch-validate-offers', { offerIds });
        stats.offersQueued += offerIds.length;

        logger.info({
          queued: stats.offersQueued,
          total: stats.totalOffers,
          percent: Math.round((stats.offersQueued / stats.totalOffers) * 100)
        }, 'Offer validation progress');
      }

      logger.info(
        { queued: stats.offersQueued, total: stats.totalOffers },
        'All offer validation jobs queued'
      );
    }

    // ============================================================================
    // Summary
    // ============================================================================
    stats.endTime = new Date();
    const duration = (stats.endTime.getTime() - stats.startTime.getTime()) / 1000;

    logger.info({
      listingsQueued: stats.listingsQueued,
      offersQueued: stats.offersQueued,
      totalQueued: stats.listingsQueued + stats.offersQueued,
      durationSeconds: duration
    }, 'Bootstrap validation complete');

    console.log('\n========================================');
    console.log('Bootstrap Validation Summary');
    console.log('========================================');
    console.log(`Active Listings Queued: ${stats.listingsQueued} / ${stats.totalListings}`);
    console.log(`Pending Offers Queued:  ${stats.offersQueued} / ${stats.totalOffers}`);
    console.log(`Total Jobs Queued:      ${stats.listingsQueued + stats.offersQueued}`);
    console.log(`Duration:               ${duration.toFixed(2)}s`);
    console.log('========================================\n');
    console.log('✓ All validation jobs have been queued');
    console.log('✓ Workers will process these jobs automatically');
    console.log('✓ Check the validation_state table to monitor progress');
    console.log('✓ Unfunded items will be marked accordingly\n');

    process.exit(0);
  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, 'Bootstrap validation failed');
    console.error('\n❌ Bootstrap validation failed:', error.message);
    process.exit(1);
  }
}

// Handle script termination
process.on('SIGINT', () => {
  logger.info('Bootstrap validation interrupted by user');
  console.log('\n\n⚠️  Bootstrap validation interrupted');
  process.exit(130);
});

process.on('SIGTERM', () => {
  logger.info('Bootstrap validation terminated');
  console.log('\n\n⚠️  Bootstrap validation terminated');
  process.exit(143);
});

// Run the script
main().catch((error) => {
  logger.error({ error }, 'Fatal error in bootstrap validation');
  console.error('Fatal error:', error);
  process.exit(1);
});
