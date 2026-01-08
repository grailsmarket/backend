/**
 * Diagnostic and fix script for stale listing data in Elasticsearch
 *
 * Finds names that have a price in ES but NO active listing in PostgreSQL.
 * This happens when listings expire via batch worker (triggers disabled).
 *
 * Usage:
 *   npx tsx src/scripts/fix-stale-listings-es.ts          # Check only (dry run)
 *   npx tsx src/scripts/fix-stale-listings-es.ts --fix    # Check and fix
 */

import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { config, getPostgresPool, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

const FIX_MODE = process.argv.includes('--fix');
const BATCH_SIZE = 1000; // ES scroll batch size
const DB_BATCH_SIZE = 500; // PostgreSQL query batch size

async function findAndFixStaleListing() {
  console.log('=== Stale Listing Detection ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will update ES)' : 'CHECK ONLY (dry run)'}\n`);

  const pool = getPostgresPool();
  const esClient = new ElasticsearchClient({
    node: config.elasticsearch.url,
  });

  try {
    // Step 1: Count total names with prices in ES
    const countResult = await esClient.count({
      index: config.elasticsearch.index,
      body: {
        query: {
          bool: {
            must: [
              { exists: { field: 'price' } },
              { range: { price: { gt: 0 } } }
            ]
          }
        }
      }
    });

    const totalWithPrices = countResult.count;
    console.log(`Total names with prices in ES: ${totalWithPrices}\n`);

    if (totalWithPrices === 0) {
      console.log('No names with prices found in ES.');
      return;
    }

    // Step 2: Use scroll API to fetch ALL names with prices
    console.log('Fetching all names with prices from Elasticsearch (using scroll)...');

    const allEsRecords: Array<{ id: number; name: string; price: number; priceUsd: number; status: string }> = [];

    // Initial search with scroll
    let scrollResponse = await esClient.search({
      index: config.elasticsearch.index,
      scroll: '2m',
      body: {
        query: {
          bool: {
            must: [
              { exists: { field: 'price' } },
              { range: { price: { gt: 0 } } }
            ]
          }
        },
        size: BATCH_SIZE,
        _source: ['name', 'price', 'status', 'price_usd']
      }
    });

    let scrollId = scrollResponse._scroll_id;
    let hits = scrollResponse.hits.hits;

    while (hits.length > 0) {
      for (const hit of hits) {
        const source = hit._source as any;
        allEsRecords.push({
          id: parseInt(hit._id as string),
          name: source.name,
          price: source.price,
          priceUsd: source.price_usd,
          status: source.status,
        });
      }

      process.stdout.write(`\r  Fetched ${allEsRecords.length} / ${totalWithPrices} from ES...`);

      // Get next batch
      scrollResponse = await esClient.scroll({
        scroll_id: scrollId,
        scroll: '2m',
      });

      scrollId = scrollResponse._scroll_id;
      hits = scrollResponse.hits.hits;
    }

    // Clear scroll
    if (scrollId) {
      await esClient.clearScroll({ scroll_id: scrollId });
    }

    console.log(`\n  Completed: ${allEsRecords.length} names with prices in ES\n`);

    // Step 3: Check against PostgreSQL in batches
    console.log('Checking active listings in PostgreSQL...');

    const idsWithActiveListings = new Set<number>();
    const allIds = allEsRecords.map(r => r.id);

    for (let i = 0; i < allIds.length; i += DB_BATCH_SIZE) {
      const batchIds = allIds.slice(i, i + DB_BATCH_SIZE);

      const dbResult = await pool.query(`
        SELECT DISTINCT en.id
        FROM ens_names en
        INNER JOIN listings l ON l.ens_name_id = en.id
        WHERE en.id = ANY($1)
          AND l.status = 'active'
      `, [batchIds]);

      for (const row of dbResult.rows) {
        idsWithActiveListings.add(row.id);
      }

      process.stdout.write(`\r  Checked ${Math.min(i + DB_BATCH_SIZE, allIds.length)} / ${allIds.length} against DB...`);
    }

    console.log(`\n  Completed: ${idsWithActiveListings.size} have active listings in DB\n`);

    // Step 4: Find stale records
    const staleRecords = allEsRecords.filter(r => !idsWithActiveListings.has(r.id));

    // Step 5: Report results
    console.log('=== Results ===\n');
    console.log(`Names with price in ES:        ${allEsRecords.length}`);
    console.log(`With active listing in DB:     ${idsWithActiveListings.size}`);
    console.log(`STALE (no active listing):     ${staleRecords.length}`);

    if (staleRecords.length === 0) {
      console.log('\nNo stale listings found. ES is in sync with DB.');
      return;
    }

    // Sort stale records by price desc for display
    staleRecords.sort((a, b) => b.price - a.price);

    console.log('\n=== Stale Records (first 30 by price) ===\n');

    for (const record of staleRecords.slice(0, 30)) {
      const priceDisplay = record.price > 1e20
        ? `${record.price.toExponential(2)} wei`
        : `${record.price} wei`;
      console.log(`${record.name}`);
      console.log(`  ID: ${record.id}, ES Price: ${priceDisplay}, ES Status: ${record.status}`);
    }

    if (staleRecords.length > 30) {
      console.log(`\n... and ${staleRecords.length - 30} more\n`);
    }

    // Step 6: Fix if requested
    if (FIX_MODE) {
      console.log('\n=== Fixing Stale Records ===\n');

      const esSync = new ElasticsearchSync();
      let fixed = 0;
      let failed = 0;

      for (let i = 0; i < staleRecords.length; i++) {
        const record = staleRecords[i];
        try {
          await esSync.updateENSNameListing(record.id);
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
      console.log('npx tsx src/scripts/fix-stale-listings-es.ts --fix\n');
    }

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await closeAllConnections();
  }
}

findAndFixStaleListing();
