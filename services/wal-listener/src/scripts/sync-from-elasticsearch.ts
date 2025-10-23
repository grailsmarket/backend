#!/usr/bin/env tsx
/**
 * Sync ENS names from Elasticsearch to PostgreSQL
 *
 * This script scans ALL names in Elasticsearch, finds ones that don't exist
 * in PostgreSQL, and creates the missing records.
 *
 * Usage:
 *   npx tsx src/scripts/sync-from-elasticsearch.ts
 */

import { getElasticsearchClient, getPostgresPool, closeAllConnections, config } from '../../../shared/src';
import { logger } from '../utils/logger';

const esClient = getElasticsearchClient();
const pool = getPostgresPool();

async function syncFromElasticsearch() {
  console.log('Starting comprehensive sync from Elasticsearch to PostgreSQL...\n');

  // First, get total count from Elasticsearch
  const countResult = await esClient.count({
    index: config.elasticsearch.index
  });
  const totalEsNames = countResult.count;
  console.log(`Total names in Elasticsearch: ${totalEsNames.toLocaleString()}`);

  // Get total count from PostgreSQL
  const pgCountResult = await pool.query('SELECT COUNT(*) as count FROM ens_names');
  const totalPgNames = parseInt(pgCountResult.rows[0].count);
  console.log(`Total names in PostgreSQL: ${totalPgNames.toLocaleString()}`);
  console.log(`Difference: ${(totalEsNames - totalPgNames).toLocaleString()} names\n`);

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const batchSize = 100;
  let processedCount = 0;

  // Scroll through all Elasticsearch documents
  let scrollId: string | undefined;
  let hasMore = true;

  try {
    // Initial search with scroll
    let response = await esClient.search({
      index: config.elasticsearch.index,
      scroll: '2m',
      size: batchSize,
      body: {
        query: { match_all: {} },
        _source: ['name', 'token_id', 'owner', 'expiry_date', 'registration_date', 'has_numbers', 'has_emoji', 'clubs', 'last_sale_price', 'last_sale_date']
      }
    });

    scrollId = response._scroll_id;

    while (hasMore && response.hits.hits.length > 0) {
      const hits = response.hits.hits;
      processedCount += hits.length;

      // Extract all names from this batch
      const names = hits.map(hit => (hit._source as any).name);

      // Check which names exist in PostgreSQL
      const existsQuery = `
        SELECT name FROM ens_names
        WHERE name = ANY($1::text[])
      `;
      const existsResult = await pool.query(existsQuery, [names]);
      const existingNames = new Set(existsResult.rows.map(row => row.name));

      // Process each document in batch
      for (const hit of hits) {
        const source = hit._source as any;

        if (existingNames.has(source.name)) {
          skipped++;
          continue;
        }

        // This name is missing from PostgreSQL - sync it
        try {
          const insertQuery = `
            INSERT INTO ens_names (
              token_id,
              name,
              owner_address,
              expiry_date,
              registration_date,
              has_numbers,
              has_emoji,
              clubs,
              last_sale_price,
              last_sale_date,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
            ON CONFLICT (token_id) DO UPDATE SET
              name = EXCLUDED.name,
              owner_address = EXCLUDED.owner_address,
              expiry_date = EXCLUDED.expiry_date,
              registration_date = EXCLUDED.registration_date,
              has_numbers = EXCLUDED.has_numbers,
              has_emoji = EXCLUDED.has_emoji,
              clubs = EXCLUDED.clubs,
              last_sale_price = EXCLUDED.last_sale_price,
              last_sale_date = EXCLUDED.last_sale_date,
              updated_at = NOW()
            RETURNING id
          `;

          await pool.query(insertQuery, [
            source.token_id,
            source.name,
            source.owner,
            source.expiry_date || null,
            source.registration_date || null,
            source.has_numbers || false,
            source.has_emoji || false,
            source.clubs || [],
            source.last_sale_price || null,
            source.last_sale_date || null
          ]);

          console.log(`✓ Synced: ${source.name} (token: ${source.token_id})`);
          synced++;

        } catch (error: any) {
          console.error(`✗ Failed to sync ${source.name}:`, error.message);
          failed++;
        }
      }

      console.log(`Progress: ${processedCount}/${totalEsNames} (${((processedCount/totalEsNames)*100).toFixed(1)}%) | Synced: ${synced} | Skipped: ${skipped} | Failed: ${failed}`);

      // Get next batch
      if (!scrollId) break;

      response = await esClient.scroll({
        scroll_id: scrollId,
        scroll: '2m'
      });

      hasMore = response.hits.hits.length > 0;
    }

  } finally {
    // Clean up scroll
    if (scrollId) {
      try {
        await esClient.clearScroll({ scroll_id: scrollId });
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }

  console.log('\n=== Sync Complete ===');
  console.log(`Total processed: ${processedCount}`);
  console.log(`Synced to PostgreSQL: ${synced}`);
  console.log(`Already existed: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log('====================\n');
}

async function main() {
  try {
    await syncFromElasticsearch();
    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
