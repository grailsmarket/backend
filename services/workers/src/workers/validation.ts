/**
 * Validation Workers
 *
 * Registers pg-boss workers for listing ownership and offer balance validation.
 * Includes both individual and batch validation workers, plus periodic schedulers.
 */

import PgBoss from 'pg-boss';
import { logger } from '../utils/logger';
import { config } from '../../../shared/src/config';
import {
  validateListingOwnership,
  batchValidateListings,
  initializeProvider as initListingProvider
} from './validate-listing-ownership';
import {
  validateOfferBalance,
  initializeProvider as initOfferProvider
} from './validate-offer-balance';
import {
  batchValidateOffers,
  initializeProvider as initBatchProvider
} from './batch-validate-offers';
import {
  updateListingStatus,
  updateOfferStatus,
  batchUpdateOfferStatuses
} from './status-update-handler';
import { getPostgresPool } from '../../../shared/src';

const pool = getPostgresPool();

// Initialize providers with RPC URL from shared config
const RPC_URL = config.blockchain.rpcUrl;
if (RPC_URL) {
  initListingProvider(RPC_URL);
  initOfferProvider(RPC_URL);
  initBatchProvider(RPC_URL);
  logger.info({ rpcUrl: RPC_URL }, 'Validation workers: RPC provider initialized');
} else {
  logger.warn('No RPC_URL configured - validation workers will fail');
}

/**
 * Individual listing ownership validation worker
 */
async function validateListingJob(job: PgBoss.Job<{ listingId: number }>) {
  const { listingId } = job.data;

  try {
    logger.debug({ listingId }, 'Validating listing ownership');

    const result = await validateListingOwnership(listingId);

    // Update status based on result
    if (!result.isValid) {
      await updateListingStatus(listingId, result);
      logger.info({ listingId, reason: result.reason }, 'Listing marked as unfunded');
    } else {
      await updateListingStatus(listingId, result);
      logger.debug({ listingId }, 'Listing ownership validated successfully');
    }

  } catch (error: any) {
    logger.error({ error, listingId }, 'Error validating listing');
    throw error; // Let pg-boss retry
  }
}

/**
 * Individual offer balance validation worker
 */
async function validateOfferJob(job: PgBoss.Job<{ offerId: number }>) {
  const { offerId } = job.data;

  try {
    logger.debug({ offerId }, 'Validating offer balance');

    const result = await validateOfferBalance(offerId);

    // Update status based on result
    if (!result.isValid) {
      await updateOfferStatus(offerId, result);
      logger.info({ offerId, reason: result.reason }, 'Offer marked as unfunded');
    } else {
      await updateOfferStatus(offerId, result);
      logger.debug({ offerId }, 'Offer balance validated successfully');
    }

  } catch (error: any) {
    logger.error({ error, offerId }, 'Error validating offer');
    throw error; // Let pg-boss retry
  }
}

/**
 * Batch offer validation worker
 */
async function batchValidateOffersJob(job: PgBoss.Job<{ offerIds: number[] }>) {
  const { offerIds } = job.data;

  try {
    logger.info({ count: offerIds.length }, 'Batch validating offers');

    const results = await batchValidateOffers(offerIds);

    // Update all statuses
    await batchUpdateOfferStatuses(results);

    const unfundedCount = Array.from(results.values()).filter(r => !r.isValid).length;
    logger.info(
      { total: offerIds.length, unfunded: unfundedCount },
      'Batch offer validation complete'
    );

  } catch (error: any) {
    logger.error({ error, count: offerIds.length }, 'Error in batch offer validation');
    throw error; // Let pg-boss retry
  }
}

/**
 * Periodic listing validator - validates oldest unvalidated listings
 */
async function periodicListingValidation(this: PgBoss) {
  const BATCH_SIZE = parseInt(process.env.LISTING_VALIDATION_BATCH_SIZE || '50', 10);

  try {
    // Find listings that need validation (oldest first)
    const result = await pool.query(`
      SELECT l.id
      FROM listings l
      LEFT JOIN validation_state vs ON vs.entity_type = 'listing' AND vs.entity_id = l.id
      WHERE l.status = 'active'
      ORDER BY COALESCE(vs.last_check_at, l.created_at) ASC
      LIMIT $1
    `, [BATCH_SIZE]);

    if (result.rows.length === 0) {
      logger.debug('No listings need validation');
      return;
    }

    logger.info({ count: result.rows.length }, 'Scheduling periodic listing validations');

    // Queue individual validation jobs
    const jobs = result.rows.map(row => ({
      name: 'validate-listing-ownership',
      data: { listingId: row.id }
    }));

    await this.insert(jobs);

  } catch (error: any) {
    logger.error({
      error,
      message: error?.message,
      stack: error?.stack,
      code: error?.code,
      detail: error?.detail
    }, 'Error in periodic listing validation');
    throw error;
  }
}

/**
 * Periodic offer validator - validates all active offers in batch
 */
async function periodicOfferValidation(this: PgBoss) {
  try {
    // Fetch all active offers
    const result = await pool.query(`
      SELECT id
      FROM offers
      WHERE status = 'pending'
      ORDER BY id
    `);

    if (result.rows.length === 0) {
      logger.debug('No offers need validation');
      return;
    }

    const offerIds = result.rows.map(row => row.id);

    logger.info({ count: offerIds.length }, 'Scheduling batch offer validation');

    // Queue batch validation job
    await this.send('batch-validate-offers', { offerIds });

  } catch (error: any) {
    logger.error({
      error,
      message: error?.message,
      stack: error?.stack,
      code: error?.code,
      detail: error?.detail
    }, 'Error in periodic offer validation');
    throw error;
  }
}

/**
 * Unfunded revalidation - check if unfunded items are now valid
 */
async function unfundedRevalidation(this: PgBoss) {
  const UNFUNDED_LISTING_MAX_AGE_DAYS = parseInt(
    process.env.UNFUNDED_LISTING_MAX_AGE_DAYS || '30',
    10
  );
  const UNFUNDED_OFFER_MAX_AGE_DAYS = parseInt(
    process.env.UNFUNDED_OFFER_MAX_AGE_DAYS || '14',
    10
  );

  try {
    // Find unfunded listings (recent only)
    const listingsResult = await pool.query(`
      SELECT id
      FROM listings
      WHERE status = 'unfunded'
        AND unfunded_at > NOW() - INTERVAL '${UNFUNDED_LISTING_MAX_AGE_DAYS} days'
      ORDER BY unfunded_at DESC
      LIMIT 100
    `);

    // Find unfunded offers (recent only)
    const offersResult = await pool.query(`
      SELECT id
      FROM offers
      WHERE status = 'unfunded'
        AND unfunded_at > NOW() - INTERVAL '${UNFUNDED_OFFER_MAX_AGE_DAYS} days'
      ORDER BY unfunded_at DESC
    `);

    // Queue listing revalidations
    if (listingsResult.rows.length > 0) {
      const jobs = listingsResult.rows.map(row => ({
        name: 'revalidate-unfunded-listing',
        data: { listingId: row.id }
      }));
      await this.insert(jobs);
      logger.info({ count: jobs.length }, 'Scheduled unfunded listing revalidations');
    }

    // Queue offer revalidations
    if (offersResult.rows.length > 0) {
      const offerIds = offersResult.rows.map(row => row.id);
      await this.send('revalidate-unfunded-offers', { offerIds });
      logger.info({ count: offerIds.length }, 'Scheduled unfunded offer revalidations');
    }

  } catch (error: any) {
    logger.error({ error }, 'Error in unfunded revalidation');
    throw error;
  }
}

/**
 * Revalidate unfunded listing - check if ownership restored
 */
async function revalidateUnfundedListingJob(job: PgBoss.Job<{ listingId: number }>) {
  const { listingId } = job.data;

  try {
    logger.debug({ listingId }, 'Revalidating unfunded listing');

    const result = await validateListingOwnership(listingId);

    if (result.isValid) {
      // Ownership restored! Mark as refunded
      await updateListingStatus(listingId, result, 'refunded');
      logger.info({ listingId }, 'Listing ownership restored - marked as active');
    } else {
      // Still unfunded, just update validation timestamp
      await updateListingStatus(listingId, result);
      logger.debug({ listingId }, 'Listing still unfunded');
    }

  } catch (error: any) {
    logger.error({ error, listingId }, 'Error revalidating unfunded listing');
    throw error;
  }
}

/**
 * Revalidate unfunded offers - check if balances restored
 */
async function revalidateUnfundedOffersJob(job: PgBoss.Job<{ offerIds: number[] }>) {
  const { offerIds } = job.data;

  try {
    logger.info({ count: offerIds.length }, 'Revalidating unfunded offers');

    const results = await batchValidateOffers(offerIds);

    // Update statuses, marking refunded ones
    for (const [offerId, result] of results.entries()) {
      if (result.isValid) {
        await updateOfferStatus(offerId, result, 'refunded');
        logger.info({ offerId }, 'Offer balance restored - marked as pending');
      } else {
        await updateOfferStatus(offerId, result);
      }
    }

    const refundedCount = Array.from(results.values()).filter(r => r.isValid).length;
    logger.info(
      { total: offerIds.length, refunded: refundedCount },
      'Unfunded offer revalidation complete'
    );

  } catch (error: any) {
    logger.error({ error, count: offerIds.length }, 'Error revalidating unfunded offers');
    throw error;
  }
}

/**
 * Register all validation workers
 */
export async function registerValidationWorkers(boss: PgBoss) {
  logger.info('Registering validation workers...');

  // Individual validation workers
  await boss.work('validate-listing-ownership', validateListingJob);
  await boss.work('validate-offer-balance', validateOfferJob);
  await boss.work('batch-validate-offers', batchValidateOffersJob);

  // Unfunded revalidation workers
  await boss.work('revalidate-unfunded-listing', revalidateUnfundedListingJob);
  await boss.work('revalidate-unfunded-offers', revalidateUnfundedOffersJob);

  logger.info('Validation workers registered');
}

/**
 * Register periodic validation schedulers
 */
export async function registerValidationSchedulers(boss: PgBoss) {
  logger.info('Registering validation schedulers...');

  const LISTING_INTERVAL = process.env.LISTING_VALIDATION_INTERVAL_MS || '60000'; // 1 minute
  const OFFER_INTERVAL = process.env.OFFER_VALIDATION_INTERVAL_MS || '300000'; // 5 minutes
  const UNFUNDED_INTERVAL = process.env.UNFUNDED_REVALIDATION_INTERVAL_MS || '900000'; // 15 minutes

  // Periodic listing validation (every 1 minute)
  await boss.work(
    'periodic-listing-validation',
    { teamSize: 1 },
    periodicListingValidation
  );
  await boss.schedule(
    'periodic-listing-validation',
    `*/${Math.floor(parseInt(LISTING_INTERVAL) / 60000)} * * * *`, // Convert ms to minutes
    {},
    { tz: 'UTC' }
  );

  // Periodic offer validation (every 5 minutes)
  await boss.work(
    'periodic-offer-validation',
    { teamSize: 1 },
    periodicOfferValidation
  );
  await boss.schedule(
    'periodic-offer-validation',
    `*/${Math.floor(parseInt(OFFER_INTERVAL) / 60000)} * * * *`, // Convert ms to minutes
    {},
    { tz: 'UTC' }
  );

  // Unfunded revalidation (every 15 minutes)
  await boss.work(
    'unfunded-revalidation',
    { teamSize: 1 },
    unfundedRevalidation
  );
  await boss.schedule(
    'unfunded-revalidation',
    `*/${Math.floor(parseInt(UNFUNDED_INTERVAL) / 60000)} * * * *`, // Convert ms to minutes
    {},
    { tz: 'UTC' }
  );

  logger.info('Validation schedulers registered');
}
