#!/usr/bin/env tsx
import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function main() {
  console.log('🔍 Checking for stale price data in ES...\n');

  // Get records from ES sorted by price (like the search endpoint does)
  const esResult = await es.search({
    index: 'ens_names',
    size: 50,
    body: {
      query: {
        term: { status: 'active' }
      },
      sort: [
        { price: { order: 'asc' } }
      ],
      _source: ['name', 'price', 'status']
    }
  });

  console.log(`Found ${esResult.hits.hits.length} records with status: active, sorted by price ASC\n`);
  
  let mismatchCount = 0;
  let noListingCount = 0;

  for (const hit of esResult.hits.hits) {
    const esId = hit._id;
    if (!esId) continue;

    const esName = (hit._source as any).name;
    const esPrice = (hit._source as any).price;

    // Get actual price from PostgreSQL
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
      WHERE en.id = $1
    `, [parseInt(esId)]);

    if (pgResult.rows.length === 0) {
      console.log(`✗ ID ${esId} not found in PG`);
      continue;
    }

    const pgName = pgResult.rows[0].name;
    const pgPrice = pgResult.rows[0].listing_price;
    const pgListingStatus = pgResult.rows[0].listing_status;

    // Check for mismatches
    if (!pgPrice || pgListingStatus !== 'active') {
      noListingCount++;
      console.log(`⚠️  ${esName} (ID: ${esId})`);
      console.log(`   ES: status=active, price=${esPrice}`);
      console.log(`   PG: No active listing (price=${pgPrice}, status=${pgListingStatus})\n`);
    } else if (esPrice !== pgPrice) {
      mismatchCount++;
      console.log(`⚠️  ${esName} (ID: ${esId})`);
      console.log(`   ES price: ${esPrice}`);
      console.log(`   PG price: ${pgPrice}`);
      console.log(`   Difference: ${Math.abs(parseInt(esPrice) - parseInt(pgPrice))} wei\n`);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Records with no active listing: ${noListingCount}`);
  console.log(`   Records with price mismatch: ${mismatchCount}`);
  console.log(`   Total issues: ${noListingCount + mismatchCount}`);

  await closeAllConnections();
}

main();
