/**
 * Backfill the Elasticsearch `character_count` field with grapheme counts.
 *
 * character_count used to be the label's JavaScript .length (UTF-16 units), so emoji and
 * other non-BMP or combining characters counted more than once (👱‍♂ was 5, 1⃣ was 2). The
 * length filter and the character_count sort both read this field. The count only changes
 * where the grapheme count differs from .length, so only those docs are updated, not a full
 * reindex. Docs re-synced by the WAL listener pick up the new count on their own.
 *
 * Scans every ens_names row (read-only), then partially updates the docs that change.
 *
 * Dry run by default; pass --apply to write. Runs against whatever DATABASE_URL /
 * ELASTICSEARCH_URL the .env points at (prod, locally) — check the target it prints.
 *
 * Usage:
 *   npm run backfill-character-count:dry
 *   npm run backfill-character-count
 */

import { getElasticsearchClient, getPostgresPool, closeAllConnections, config, nameCharacterCount } from '../../../shared/src';

const BATCH_SIZE = 50000;
const ES_BULK_SIZE = 1000;

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = getPostgresPool();
  const es = getElasticsearchClient();
  const index = config.elasticsearch.index;

  // Hosts only — the URLs can carry credentials
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return 'unknown';
    }
  };
  console.log(`Target: DB ${hostOf(config.database.url)}, ES ${hostOf(config.elasticsearch.url)} index "${index}"`);
  console.log(apply ? 'Mode: APPLY (writing to Elasticsearch)\n' : 'Mode: dry run (pass --apply to write)\n');

  // 1. Find names whose grapheme count differs from the old UTF-16 count
  const changed: Array<{ id: number; name: string; oldCount: number; newCount: number }> = [];
  let lastId = 0;
  let scanned = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM ens_names WHERE id > $1 ORDER BY id LIMIT $2',
      [lastId, BATCH_SIZE]
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const name = row.name || '';
      const oldCount = name.replace('.eth', '').length;
      const newCount = nameCharacterCount(name);
      if (oldCount !== newCount) changed.push({ id: row.id, name, oldCount, newCount });
    }
    scanned += rows.length;
    lastId = rows[rows.length - 1].id;
    process.stdout.write(`\rScanned ${scanned} names, ${changed.length} to update`);
  }
  console.log('\n');

  console.log(`${changed.length} docs change. Examples:`);
  for (const r of changed.slice(0, 15)) console.log(`  ${r.id}\t${r.oldCount} -> ${r.newCount}\t${r.name}`);

  if (!apply) {
    console.log('\nDry run — nothing written.');
    return;
  }

  // 2. Partial-update only the changed docs
  let updated = 0;
  let missing = 0;
  let errors = 0;
  for (let i = 0; i < changed.length; i += ES_BULK_SIZE) {
    const chunk = changed.slice(i, i + ES_BULK_SIZE);
    const body = chunk.flatMap((r) => [
      { update: { _index: index, _id: r.id.toString() } },
      { doc: { character_count: r.newCount } },
    ]);
    const response: any = await es.bulk({ body, refresh: false });
    for (const item of response.items ?? response.body?.items ?? []) {
      const result = item.update;
      if (!result?.error) updated++;
      else if (result.status === 404) missing++;
      else {
        errors++;
        console.error(`  ${result._id}: ${result.error.type} ${result.error.reason}`);
      }
    }
    process.stdout.write(`\rUpdated ${updated}/${changed.length}`);
  }

  console.log(`\nUpdated ${updated} docs, ${missing} not in the index, ${errors} errors`);

  // Bulk returns per-doc failures without throwing; those names keep the old count
  if (errors > 0) {
    throw new Error(`${errors} Elasticsearch updates failed; re-run to retry`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeAllConnections());
