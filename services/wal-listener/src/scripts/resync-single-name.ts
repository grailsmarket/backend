import { getPostgresPool } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

/**
 * Resync a single ENS name to Elasticsearch
 * Usage: node dist/scripts/resync-single-name.js <name or id>
 */
async function resyncSingleName() {
  const pool = getPostgresPool();
  const esSync = new ElasticsearchSync();

  // Get name or id from command line
  const arg = process.argv[2];

  if (!arg) {
    console.error('Usage: node dist/scripts/resync-single-name.js <name or id>');
    console.error('Example: node dist/scripts/resync-single-name.js vitalik.eth');
    console.error('Example: node dist/scripts/resync-single-name.js 12345');
    process.exit(1);
  }

  try {
    console.log(`Looking up ENS name: ${arg}\n`);

    // Determine if arg is a name or an id
    const isId = /^\d+$/.test(arg);

    let query: string;
    let params: any[];

    if (isId) {
      query = 'SELECT id, name FROM ens_names WHERE id = $1';
      params = [parseInt(arg)];
    } else {
      query = 'SELECT id, name FROM ens_names WHERE name = $1';
      params = [arg];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      console.error(`ENS name not found: ${arg}`);
      process.exit(1);
    }

    const { id, name } = result.rows[0];
    console.log(`Found ENS name: ${name} (ID: ${id})`);
    console.log(`Resyncing to Elasticsearch...\n`);

    // Resync using the same method the WAL listener uses
    await esSync.updateENSNameListing(id);

    console.log(`✓ Successfully resynced ${name} to Elasticsearch`);

    await pool.end();
    process.exit(0);

  } catch (error: any) {
    console.error(`Failed to resync: ${error.message}`);
    console.error(error);
    await pool.end();
    process.exit(1);
  }
}

resyncSingleName();
