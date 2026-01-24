/**
 * Diagnostic and fix script for stale offer data in Elasticsearch
 *
 * Finds names where:
 * 1. ES has highest_offer but DB has no active pending offers
 * 2. ES highest_offer doesn't match DB highest_offer_wei
 *
 * This happens due to a race condition: WAL listener syncs to ES before
 * the recalculate-highest-offer worker updates the database.
 *
 * Usage:
 *   npx tsx src/scripts/fix-stale-offers-es.ts          # Check only (dry run)
 *   npx tsx src/scripts/fix-stale-offers-es.ts --fix    # Check and fix
 */

import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { config, getPostgresPool, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

const FIX_MODE = process.argv.includes('--fix');
const BATCH_SIZE = 1000; // ES scroll batch size
const DB_BATCH_SIZE = 500; // PostgreSQL query batch size

interface ESOfferRecord {
  id: number;
  name: string;
  highestOffer: number | null;
  activeOffersCount: number;
}

interface DBOfferData {
  id: number;
  highestOfferWei: string | null;
  activeOffersCount: number;
}

async function findAndFixStaleOffers() {
  console.log('=== Stale Offer Data Detection ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will update ES)' : 'CHECK ONLY (dry run)'}\n`);

  const pool = getPostgresPool();
  const esClient = new ElasticsearchClient({
    node: config.elasticsearch.url,
  });

  try {
    // Step 1: Count total names with highest_offer in ES
    const countResult = await esClient.count({
      index: config.elasticsearch.index,
      body: {
        query: {
          bool: {
            must: [
              { exists: { field: 'highest_offer' } },
              { range: { highest_offer: { gt: 0 } } }
            ]
          }
        }
      }
    });

    const totalWithOffers = countResult.count;
    console.log(`Total names with highest_offer in ES: ${totalWithOffers}\n`);

    if (totalWithOffers === 0) {
      console.log('No names with highest_offer found in ES.');
      return;
    }

    // Step 2: Use scroll API to fetch ALL names with highest_offer
    console.log('Fetching all names with highest_offer from Elasticsearch (using scroll)...');

    const allEsRecords: ESOfferRecord[] = [];

    // Initial search with scroll
    let scrollResponse = await esClient.search({
      index: config.elasticsearch.index,
      scroll: '2m',
      body: {
        query: {
          bool: {
            must: [
              { exists: { field: 'highest_offer' } },
              { range: { highest_offer: { gt: 0 } } }
            ]
          }
        },
        size: BATCH_SIZE,
        _source: ['name', 'highest_offer', 'active_offers_count']
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
          highestOffer: source.highest_offer,
          activeOffersCount: source.active_offers_count || 0,
        });
      }

      process.stdout.write(`\r  Fetched ${allEsRecords.length} / ${totalWithOffers} from ES...`);

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

    console.log(`\n  Completed: ${allEsRecords.length} names with highest_offer in ES\n`);

    // Step 3: Check against PostgreSQL in batches
    console.log('Checking offer data in PostgreSQL...');

    const dbOfferData = new Map<number, DBOfferData>();
    const allIds = allEsRecords.map(r => r.id);

    for (let i = 0; i < allIds.length; i += DB_BATCH_SIZE) {
      const batchIds = allIds.slice(i, i + DB_BATCH_SIZE);

      const dbResult = await pool.query(`
        SELECT
          en.id,
          en.highest_offer_wei,
          COUNT(DISTINCT o.id) FILTER (
            WHERE o.status = 'pending'
            AND (o.expires_at IS NULL OR o.expires_at > NOW())
          ) as active_offers_count
        FROM ens_names en
        LEFT JOIN offers o ON o.ens_name_id = en.id
        WHERE en.id = ANY($1)
        GROUP BY en.id
      `, [batchIds]);

      for (const row of dbResult.rows) {
        dbOfferData.set(row.id, {
          id: row.id,
          highestOfferWei: row.highest_offer_wei,
          activeOffersCount: parseInt(row.active_offers_count) || 0,
        });
      }

      process.stdout.write(`\r  Checked ${Math.min(i + DB_BATCH_SIZE, allIds.length)} / ${allIds.length} against DB...`);
    }

    console.log(`\n  Completed: ${dbOfferData.size} records checked in DB\n`);

    // Step 4: Find stale records
    const staleRecords: Array<{
      esRecord: ESOfferRecord;
      dbData: DBOfferData | undefined;
      reason: string;
    }> = [];

    for (const esRecord of allEsRecords) {
      const dbData = dbOfferData.get(esRecord.id);

      // Case 1: No DB record found (shouldn't happen but handle it)
      if (!dbData) {
        staleRecords.push({
          esRecord,
          dbData: undefined,
          reason: 'No DB record found',
        });
        continue;
      }

      // Case 2: ES has highest_offer but DB has no active pending offers
      if (dbData.activeOffersCount === 0 && esRecord.highestOffer && esRecord.highestOffer > 0) {
        staleRecords.push({
          esRecord,
          dbData,
          reason: 'No active offers in DB',
        });
        continue;
      }

      // Case 3: ES highest_offer doesn't match DB highest_offer_wei
      const esOffer = esRecord.highestOffer || 0;
      const dbOffer = dbData.highestOfferWei ? parseFloat(dbData.highestOfferWei) : 0;

      // Allow for small floating point differences
      if (Math.abs(esOffer - dbOffer) > 1) {
        staleRecords.push({
          esRecord,
          dbData,
          reason: `Mismatch: ES=${esOffer}, DB=${dbOffer}`,
        });
        continue;
      }
    }

    // Step 5: Report results
    console.log('=== Results ===\n');
    console.log(`Names with highest_offer in ES:  ${allEsRecords.length}`);
    console.log(`STALE (needs update):            ${staleRecords.length}`);

    if (staleRecords.length === 0) {
      console.log('\nNo stale offer data found. ES is in sync with DB.');
      return;
    }

    // Count by reason
    const reasonCounts = new Map<string, number>();
    for (const record of staleRecords) {
      const baseReason = record.reason.startsWith('Mismatch') ? 'Mismatch' : record.reason;
      reasonCounts.set(baseReason, (reasonCounts.get(baseReason) || 0) + 1);
    }

    console.log('\nBreakdown by reason:');
    reasonCounts.forEach((count, reason) => {
      console.log(`  ${reason}: ${count}`);
    });

    // Sort stale records by highest offer desc for display
    staleRecords.sort((a, b) => (b.esRecord.highestOffer || 0) - (a.esRecord.highestOffer || 0));

    console.log('\n=== Stale Records (first 30 by offer amount) ===\n');

    for (const { esRecord, dbData, reason } of staleRecords.slice(0, 30)) {
      const offerDisplay = esRecord.highestOffer && esRecord.highestOffer > 1e20
        ? `${esRecord.highestOffer.toExponential(2)} wei`
        : `${esRecord.highestOffer || 0} wei`;

      console.log(`${esRecord.name}`);
      console.log(`  ID: ${esRecord.id}`);
      console.log(`  ES highest_offer: ${offerDisplay}`);
      console.log(`  DB highest_offer_wei: ${dbData?.highestOfferWei || 'NULL'}`);
      console.log(`  DB active offers: ${dbData?.activeOffersCount || 0}`);
      console.log(`  Reason: ${reason}`);
      console.log('');
    }

    if (staleRecords.length > 30) {
      console.log(`... and ${staleRecords.length - 30} more\n`);
    }

    // Step 6: Fix if requested
    if (FIX_MODE) {
      console.log('\n=== Fixing Stale Records ===\n');

      const esSync = new ElasticsearchSync();
      let fixed = 0;
      let failed = 0;

      for (let i = 0; i < staleRecords.length; i++) {
        const { esRecord } = staleRecords[i];
        try {
          await esSync.updateENSNameOffers(esRecord.id);
          fixed++;
          if (fixed % 50 === 0 || fixed === staleRecords.length) {
            console.log(`  Progress: ${fixed} / ${staleRecords.length} fixed`);
          }
        } catch (error: any) {
          failed++;
          console.error(`  [FAILED] ${esRecord.name} (ID: ${esRecord.id}): ${error.message}`);
        }
      }

      console.log(`\n=== Fix Summary ===`);
      console.log(`Fixed:  ${fixed}`);
      console.log(`Failed: ${failed}`);
    } else {
      console.log('\n=== To fix these records, run with --fix flag ===');
      console.log('npx tsx src/scripts/fix-stale-offers-es.ts --fix\n');
    }

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await closeAllConnections();
  }
}

findAndFixStaleOffers();
