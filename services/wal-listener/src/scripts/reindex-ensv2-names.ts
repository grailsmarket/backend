/**
 * Re-index every ENSv2 name (ens_names.ens_version = 2) in Elasticsearch.
 *
 * Search uses each document's ens_version to apply the 28-day v2 grace period. Documents
 * indexed before that field existed are treated as v1 until re-indexed, which this does.
 * Also adds ens_version to the index mapping if it's missing. Safe to re-run.
 *
 * Prints the target database and index, then waits for "yes" before writing.
 *
 * Usage: npm run reindex-ensv2 (from services/wal-listener)
 */

import * as readline from 'readline';
import { config, getPostgresPool, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

function host(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '(default port)'}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main() {
  const pool = getPostgresPool();
  console.log(`Chain:         ${config.blockchain.chainId}`);
  console.log(`Database:      ${host(config.database.url)}`);
  console.log(`Elasticsearch: ${host(config.elasticsearch.url)} index "${config.elasticsearch.index}"`);
  if (!(await confirm('Re-index ENSv2 names into this index? Type "yes" to continue: '))) {
    console.log('Aborted, nothing written.');
    return;
  }

  const sync = new ElasticsearchSync();
  await sync.createIndex(); // adds ens_version to the mapping if missing

  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM ens_names WHERE ens_version = 2 ORDER BY id'
  );
  console.log(`Re-indexing ${rows.length} ENSv2 names...`);

  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      await sync.updateENSNameListing(rows[i].id);
    } catch (error: any) {
      failed++;
      console.error(`Failed ens_names.id ${rows[i].id}: ${error.message}`);
    }
    if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${rows.length}`);
  }
  console.log(`Done: ${rows.length - failed} re-indexed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeAllConnections());
