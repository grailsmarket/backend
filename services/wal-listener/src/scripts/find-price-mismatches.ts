#!/usr/bin/env tsx
import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function main() {
  console.log('🔍 Finding price mismatches between ES and PG...\n');

  const mismatchIds: number[] = [];
  let totalChecked = 0;
  let scrollId: string | undefined;

  // Get all ES records with status: active (should have prices)
  const searchResponse = await es.search({
    index: 'ens_names',
    scroll: '2m',
    size: 1000,
    body: {
      query: {
        term: { status: 'active' }
      },
      _source: ['name', 'price', 'status']
    }
  });

  scrollId = searchResponse._scroll_id;
  let hits = searchResponse.hits.hits;

  while (hits.length > 0) {
    const esIds = hits.map((hit: any) => parseInt(hit._id));
    totalChecked += esIds.length;

    console.log(`Checking batch of ${esIds.length} (${totalChecked} total checked)...`);

    // Get actual prices from PostgreSQL
    const pgResult = await pool.query(`
      SELECT 
        en.id,
        en.name,
        l.price_wei as listing_price,
        l.status as listing_status
      FROM ens_names en
      LEFT JOIN LATERAL (
        SELECT * FROM listings
        WHERE listings.ens_name_id = en.id
        AND listings.status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      ) l ON true
      WHERE en.id = ANY($1)
    `, [esIds]);

    // Create a map of PG prices
    const pgPrices = new Map();
    for (const row of pgResult.rows) {
      pgPrices.set(row.id, {
        name: row.name,
        price: row.listing_price,
        status: row.listing_status
      });
    }

    // Compare ES prices with PG prices
    for (const hit of hits) {
      if (!hit._id) continue;
      const esId = parseInt(hit._id);
      const esPrice = (hit._source as any).price;
      const esName = (hit._source as any).name;

      const pgData = pgPrices.get(esId);
      
      if (pgData) {
        if (pgData.status !== 'active' || !pgData.price) {
          // ES says active but PG has no active listing - should have been caught earlier
          mismatchIds.push(esId);
          console.log(`  ⚠️  ${esName} (ID: ${esId}) - ES has price but PG has no active listing`);
        } else if (esPrice !== pgData.price) {
          // Prices don't match
          mismatchIds.push(esId);
          console.log(`  ⚠️  ${esName} (ID: ${esId})`);
          console.log(`      ES price: ${esPrice}`);
          console.log(`      PG price: ${pgData.price}`);
        }
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
  console.log(`   Price mismatches: ${mismatchIds.length}`);

  if (mismatchIds.length > 0) {
    console.log(`\n💡 These records need to be resynced to fix sort order.`);
    console.log(`   First 20 IDs to resync: ${mismatchIds.slice(0, 20).join(', ')}`);
  }

  await closeAllConnections();
}

main();
