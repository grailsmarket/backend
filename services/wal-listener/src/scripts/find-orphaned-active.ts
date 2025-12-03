#!/usr/bin/env tsx
import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function main() {
  console.log('🔍 Finding orphaned ES documents with status: active...\n');

  const orphanedIds: string[] = [];
  let totalChecked = 0;
  let scrollId: string | undefined;

  // Search all ES docs with status: active
  const searchResponse = await es.search({
    index: 'ens_names',
    scroll: '2m',
    size: 1000,
    body: {
      query: {
        term: { status: 'active' }
      },
      _source: ['name', 'price']
    }
  });

  scrollId = searchResponse._scroll_id;
  let hits = searchResponse.hits.hits;

  while (hits.length > 0) {
    const esIds = hits.map((hit: any) => parseInt(hit._id));
    totalChecked += esIds.length;

    console.log(`Checking batch of ${esIds.length} (${totalChecked} total checked)...`);

    // Check which IDs exist in PG
    const pgResult = await pool.query(
      'SELECT id FROM ens_names WHERE id = ANY($1)',
      [esIds]
    );

    const pgIds = new Set(pgResult.rows.map(row => row.id));

    // Find IDs that don't exist in PG
    for (const hit of hits) {
      if (!hit._id) continue;
      const esId = parseInt(hit._id);
      if (!pgIds.has(esId)) {
        orphanedIds.push(hit._id);
        const name = (hit._source as any).name;
        const price = (hit._source as any).price;
        console.log(`  ✗ Orphaned: ID ${hit._id} | ${name} | Price: ${price}`);
      }
    }

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

  console.log(`\n📊 Summary:`);
  console.log(`   Total checked: ${totalChecked}`);
  console.log(`   Orphaned (ID not in PG): ${orphanedIds.length}`);

  if (orphanedIds.length > 0) {
    console.log(`\n💡 These orphaned records should be deleted from ES.`);
    console.log(`   They are causing incorrect sort results.`);
  }

  await closeAllConnections();
}

main();
