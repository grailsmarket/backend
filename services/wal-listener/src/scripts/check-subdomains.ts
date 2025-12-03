#!/usr/bin/env tsx
import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function main() {
  // Get subdomain records from PostgreSQL
  const pgResult = await pool.query(
    `SELECT id, name, token_id FROM ens_names WHERE name LIKE '%.%.eth' LIMIT 20`
  );

  console.log(`\n📊 Found ${pgResult.rows.length} subdomain records in PostgreSQL:\n`);

  for (const row of pgResult.rows) {
    console.log(`PG ID: ${row.id} | Name: ${row.name} | Token ID: ${row.token_id}`);

    // Check what ES has for this ID
    try {
      const esDoc = await es.get({
        index: 'ens_names',
        id: row.id.toString()
      });

      const esName = (esDoc._source as any).name;
      const match = esName === row.name ? '✓' : '✗';
      console.log(`   ES: ${esName} ${match}`);

      if (esName !== row.name) {
        console.log(`   ⚠️  MISMATCH: PG says "${row.name}", ES says "${esName}"\n`);
      }
    } catch (error: any) {
      if (error.statusCode === 404) {
        console.log(`   ✗ Not found in ES\n`);
      } else {
        console.log(`   ✗ Error: ${error.message}\n`);
      }
    }
  }

  await closeAllConnections();
}

main();
