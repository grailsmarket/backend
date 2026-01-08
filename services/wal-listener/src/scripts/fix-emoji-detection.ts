#!/usr/bin/env tsx
/**
 * Fix has_emoji field for names that were incorrectly marked
 *
 * The previous emoji regex was missing the U+1F900-U+1F9FF range which includes
 * emojis like 🦖 (dinosaur), 🦁 (lion face), etc.
 *
 * This script updates Elasticsearch directly (which powers search).
 * PostgreSQL's has_emoji field remains stale but this has no practical impact
 * since search queries use Elasticsearch, not PostgreSQL.
 *
 * Usage:
 *   npx tsx src/scripts/fix-emoji-detection.ts [--dry-run]
 */

import { getPostgresPool, getElasticsearchClient, closeAllConnections, hasEmoji, config } from '../../../shared/src';

const pool = getPostgresPool();
const esClient = getElasticsearchClient();
const DRY_RUN = process.argv.includes('--dry-run');
const ES_BATCH_SIZE = 500;

interface NameToFix {
  id: number;
  name: string;
  token_id: string;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Fix Emoji Detection Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (will update Elasticsearch)'}`);
  console.log('='.repeat(60));
  console.log();

  // Find all names where has_emoji is false but actually contain emojis
  console.log('Scanning for names with incorrect has_emoji=false...');
  const result = await pool.query<NameToFix>(
    `SELECT id, name, token_id FROM ens_names WHERE has_emoji = false AND name NOT LIKE 'token-%'`
  );

  console.log(`Checked ${result.rows.length} names with has_emoji=false`);

  const namesToFix: NameToFix[] = [];
  for (const row of result.rows) {
    if (hasEmoji(row.name)) {
      namesToFix.push(row);
    }
  }

  console.log(`Found ${namesToFix.length} names that need has_emoji updated to true`);
  console.log();

  if (namesToFix.length === 0) {
    console.log('No names need fixing. Exiting.');
    await closeAllConnections();
    return;
  }

  // Show some examples
  console.log('Examples of names to fix:');
  for (const row of namesToFix.slice(0, 10)) {
    console.log(`  - ${row.name}`);
  }
  if (namesToFix.length > 10) {
    console.log(`  ... and ${namesToFix.length - 10} more`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`Would update ${namesToFix.length} names in Elasticsearch (dry run).`);
    await closeAllConnections();
    return;
  }

  // Update Elasticsearch directly (no trigger issues, search works immediately)
  console.log('Updating Elasticsearch...');
  const indexName = config.elasticsearch?.index || 'ens_names';
  let esUpdated = 0;
  let esErrors = 0;

  for (let i = 0; i < namesToFix.length; i += ES_BATCH_SIZE) {
    const batch = namesToFix.slice(i, i + ES_BATCH_SIZE);

    const operations = batch.flatMap(row => [
      { update: { _index: indexName, _id: row.token_id } },
      { doc: { has_emoji: true } }
    ]);

    const response = await esClient.bulk({ operations, refresh: false });

    if (response.errors) {
      const errorItems = response.items.filter((item: any) => item.update?.error);
      esErrors += errorItems.length;
    }

    esUpdated += batch.length;
    console.log(`  Updated ${esUpdated}/${namesToFix.length} in Elasticsearch...`);
  }

  // Refresh the index
  console.log('Refreshing Elasticsearch index...');
  await esClient.indices.refresh({ index: indexName });
  console.log('Elasticsearch update complete.');

  console.log();
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Names fixed in Elasticsearch: ${namesToFix.length}`);
  if (esErrors > 0) {
    console.log(`Errors: ${esErrors}`);
  }
  console.log();
  console.log('Note: PostgreSQL has_emoji field will be corrected when names are next synced.');

  await closeAllConnections();
}

main().catch(async err => {
  console.error('Script failed:', err);
  await closeAllConnections();
  process.exit(1);
});
