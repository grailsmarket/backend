#!/usr/bin/env tsx
import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function main() {
  // Get the same sorted results that the API endpoint gets
  const esResult = await es.search({
    index: 'ens_names',
    size: 20,
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

  console.log('Comparing ES prices vs PG prices for top 20 sorted results:\n');
  console.log('ES sorts by its price field, then API fetches actual prices from PG\n');

  for (const hit of esResult.hits.hits) {
    const esId = hit._id;
    if (!esId) continue;

    const esName = (hit._source as any).name;
    const esPrice = (hit._source as any).price;

    // Get actual price from PostgreSQL
    const pgResult = await pool.query(`
      SELECT
        l.price_wei
      FROM ens_names en
      LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
      WHERE en.id = $1
      ORDER BY l.created_at DESC
      LIMIT 1
    `, [parseInt(esId)]);

    const pgPrice = pgResult.rows[0]?.price_wei;
    
    const esEth = esPrice ? (parseFloat(esPrice) / 1e18).toFixed(4) : 'N/A';
    const pgEth = pgPrice ? (parseFloat(pgPrice) / 1e18).toFixed(4) : 'N/A';
    
    const match = esPrice === pgPrice ? '✓' : '✗';
    
    console.log(`${match} ${esName.padEnd(25)} ES: ${esEth.padStart(10)} ETH | PG: ${pgEth.padStart(10)} ETH`);
    
    if (esPrice !== pgPrice) {
      console.log(`  MISMATCH! ES has ${esPrice}, PG has ${pgPrice}`);
    }
  }

  await closeAllConnections();
}

main();
