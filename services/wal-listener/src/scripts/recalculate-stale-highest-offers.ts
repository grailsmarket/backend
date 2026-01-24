/**
 * Recalculate Stale Highest Offers Script
 *
 * Finds and fixes ENS names where highest_offer_wei doesn't match actual pending offers.
 * This handles cases where:
 * 1. highest_offer_wei exists but there are no active ETH/WETH offers (should be NULL)
 * 2. highest_offer_wei doesn't match the actual highest active ETH/WETH offer
 *
 * Usage:
 *   npx tsx src/scripts/recalculate-stale-highest-offers.ts          # Check only (dry run)
 *   npx tsx src/scripts/recalculate-stale-highest-offers.ts --fix    # Check and fix
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

const FIX_MODE = process.argv.includes('--fix');
const BATCH_SIZE = 500;

// Only ETH and WETH are tracked for highest offer
const TRACKED_CURRENCIES = [
  '0x0000000000000000000000000000000000000000', // Native ETH
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
];

interface StaleRecord {
  id: number;
  name: string;
  currentHighestOfferWei: string | null;
  currentHighestOfferId: number | null;
  currentCurrency: string | null;
  actualHighestOfferWei: string | null;
  actualHighestOfferId: number | null;
  actualCurrency: string | null;
  reason: string;
}

async function recalculateStaleHighestOffers() {
  console.log('=== Recalculate Stale Highest Offers ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will update DB and ES)' : 'CHECK ONLY (dry run)'}\n`);

  const pool = getPostgresPool();

  try {
    // Step 1: Find all names that have highest_offer_wei set
    console.log('Finding ENS names with highest_offer_wei set...');

    const namesWithOfferResult = await pool.query(`
      SELECT id, name, highest_offer_wei, highest_offer_id, highest_offer_currency
      FROM ens_names
      WHERE highest_offer_wei IS NOT NULL
      ORDER BY highest_offer_wei::numeric DESC
    `);

    const namesWithOffer = namesWithOfferResult.rows;
    console.log(`Found ${namesWithOffer.length} names with highest_offer_wei set\n`);

    if (namesWithOffer.length === 0) {
      console.log('No names with highest_offer_wei found.');
      return;
    }

    // Step 2: For each name, check what the actual highest offer should be
    console.log('Checking actual highest offers from pending offers...');

    const staleRecords: StaleRecord[] = [];
    let checked = 0;

    for (let i = 0; i < namesWithOffer.length; i += BATCH_SIZE) {
      const batch = namesWithOffer.slice(i, i + BATCH_SIZE);
      const batchIds = batch.map(r => r.id);

      // Get the actual highest ETH/WETH offer for each name
      const actualOffersResult = await pool.query(`
        SELECT DISTINCT ON (o.ens_name_id)
          o.ens_name_id,
          o.id as offer_id,
          o.offer_amount_wei,
          o.currency_address
        FROM offers o
        WHERE o.ens_name_id = ANY($1)
          AND o.status = 'pending'
          AND o.currency_address = ANY($2)
          AND (o.expires_at IS NULL OR o.expires_at > NOW())
        ORDER BY o.ens_name_id, o.offer_amount_wei::numeric DESC
      `, [batchIds, TRACKED_CURRENCIES]);

      // Create a map of actual highest offers
      const actualOfferMap = new Map<number, {
        offerId: number;
        offerAmountWei: string;
        currencyAddress: string;
      }>();

      for (const row of actualOffersResult.rows) {
        actualOfferMap.set(row.ens_name_id, {
          offerId: row.offer_id,
          offerAmountWei: row.offer_amount_wei,
          currencyAddress: row.currency_address,
        });
      }

      // Compare current vs actual
      for (const name of batch) {
        const actual = actualOfferMap.get(name.id);

        if (!actual) {
          // No active ETH/WETH offers, but highest_offer_wei is set
          staleRecords.push({
            id: name.id,
            name: name.name,
            currentHighestOfferWei: name.highest_offer_wei,
            currentHighestOfferId: name.highest_offer_id,
            currentCurrency: name.highest_offer_currency,
            actualHighestOfferWei: null,
            actualHighestOfferId: null,
            actualCurrency: null,
            reason: 'No active ETH/WETH offers (should be NULL)',
          });
        } else if (name.highest_offer_wei !== actual.offerAmountWei) {
          // Mismatch between stored and actual
          staleRecords.push({
            id: name.id,
            name: name.name,
            currentHighestOfferWei: name.highest_offer_wei,
            currentHighestOfferId: name.highest_offer_id,
            currentCurrency: name.highest_offer_currency,
            actualHighestOfferWei: actual.offerAmountWei,
            actualHighestOfferId: actual.offerId,
            actualCurrency: actual.currencyAddress,
            reason: 'Amount mismatch',
          });
        }
      }

      checked += batch.length;
      process.stdout.write(`\r  Checked ${checked} / ${namesWithOffer.length}...`);
    }

    console.log('\n');

    // Step 3: Report results
    console.log('=== Results ===\n');
    console.log(`Names with highest_offer_wei:  ${namesWithOffer.length}`);
    console.log(`STALE (needs update):          ${staleRecords.length}`);

    if (staleRecords.length === 0) {
      console.log('\nNo stale highest_offer_wei values found. Database is correct.');
      return;
    }

    // Count by reason
    const shouldBeNull = staleRecords.filter(r => r.actualHighestOfferWei === null).length;
    const amountMismatch = staleRecords.filter(r => r.actualHighestOfferWei !== null).length;

    console.log('\nBreakdown:');
    console.log(`  Should be NULL (no active ETH/WETH offers): ${shouldBeNull}`);
    console.log(`  Amount mismatch:                            ${amountMismatch}`);

    // Show first 30
    console.log('\n=== Stale Records (first 30) ===\n');

    for (const record of staleRecords.slice(0, 30)) {
      console.log(`${record.name}`);
      console.log(`  ID: ${record.id}`);
      console.log(`  Current: ${record.currentHighestOfferWei} wei (offer ID: ${record.currentHighestOfferId})`);
      console.log(`  Actual:  ${record.actualHighestOfferWei || 'NULL'} ${record.actualHighestOfferId ? `(offer ID: ${record.actualHighestOfferId})` : ''}`);
      console.log(`  Reason:  ${record.reason}`);
      console.log('');
    }

    if (staleRecords.length > 30) {
      console.log(`... and ${staleRecords.length - 30} more\n`);
    }

    // Step 4: Fix if requested
    if (FIX_MODE) {
      console.log('\n=== Fixing Stale Records ===\n');

      const esSync = new ElasticsearchSync();
      let fixed = 0;
      let failed = 0;

      for (const record of staleRecords) {
        try {
          if (record.actualHighestOfferWei === null) {
            // Clear the highest offer
            await pool.query(`
              UPDATE ens_names
              SET highest_offer_wei = NULL,
                  highest_offer_id = NULL,
                  highest_offer_currency = NULL,
                  last_offer_update = NOW()
              WHERE id = $1
            `, [record.id]);
          } else {
            // Update to correct value
            await pool.query(`
              UPDATE ens_names
              SET highest_offer_wei = $1,
                  highest_offer_id = $2,
                  highest_offer_currency = $3,
                  last_offer_update = NOW()
              WHERE id = $4
            `, [
              record.actualHighestOfferWei,
              record.actualHighestOfferId,
              record.actualCurrency,
              record.id,
            ]);
          }

          // Sync to Elasticsearch
          await esSync.updateENSNameOffers(record.id);

          fixed++;
          if (fixed % 50 === 0 || fixed === staleRecords.length) {
            console.log(`  Progress: ${fixed} / ${staleRecords.length} fixed`);
          }
        } catch (error: any) {
          failed++;
          console.error(`  [FAILED] ${record.name} (ID: ${record.id}): ${error.message}`);
        }
      }

      console.log(`\n=== Fix Summary ===`);
      console.log(`Fixed:  ${fixed}`);
      console.log(`Failed: ${failed}`);
    } else {
      console.log('\n=== To fix these records, run with --fix flag ===');
      console.log('npx tsx src/scripts/recalculate-stale-highest-offers.ts --fix\n');
    }

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await closeAllConnections();
  }
}

recalculateStaleHighestOffers();
