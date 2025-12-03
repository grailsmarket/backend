#!/usr/bin/env tsx
/**
 * Fix Price Format in Elasticsearch
 *
 * Resyncs all records with status: active to convert string prices to numbers.
 * This fixes the sorting issue where ES can't sort scaled_float fields with string values.
 *
 * Usage:
 *   npx tsx src/scripts/fix-price-format.ts
 */

import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function main() {
  console.log('🔧 Fixing price format in Elasticsearch...\n');

  // Get all IDs with status: active from ES
  const activeIds: number[] = [];
  let scrollId: string | undefined;

  const searchResponse = await es.search({
    index: 'ens_names',
    scroll: '2m',
    size: 1000,
    body: {
      query: {
        term: { status: 'active' }
      },
      _source: false
    }
  });

  scrollId = searchResponse._scroll_id;
  let hits = searchResponse.hits.hits;

  while (hits.length > 0) {
    const ids = hits.map((hit: any) => parseInt(hit._id));
    activeIds.push(...ids);

    console.log(`Found ${activeIds.length} records with status: active...`);

    // Get next batch
    if (scrollId) {
      const scrollResponse = await es.scroll({
        scroll_id: scrollId,
        scroll: '2m'
      });

      hits = scrollResponse.hits.hits;
      scrollId = scrollResponse._scroll_id;
    } else {
      break;
    }
  }

  // Clear scroll
  if (scrollId) {
    await es.clearScroll({ scroll_id: scrollId });
  }

  console.log(`\n📝 Resyncing ${activeIds.length} records to fix price format...\n`);

  const sync = new ElasticsearchSync();
  const batchSize = 100;
  let synced = 0;

  for (let i = 0; i < activeIds.length; i += batchSize) {
    const batch = activeIds.slice(i, i + batchSize);

    console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (${i + 1}-${Math.min(i + batchSize, activeIds.length)} of ${activeIds.length})...`);

    for (const id of batch) {
      try {
        await sync.updateENSNameListing(id);
        synced++;
      } catch (error: any) {
        console.error(`  ✗ Failed to sync ID ${id}: ${error.message}`);
      }
    }

    console.log(`  ✓ Synced ${synced}/${activeIds.length} records`);

    // Small delay to avoid overwhelming ES
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n✨ Fix complete! Updated ${synced} records with correct price format.`);

  await closeAllConnections();
  process.exit(0);
}

main().catch(error => {
  console.error('💥 Error:', error.message);
  console.error(error.stack);
  closeAllConnections();
  process.exit(1);
});
