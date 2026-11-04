/**
 * Backfill the Elasticsearch `is_normalized` field.
 *
 * Search hides docs with `is_normalized: false` (names like "Jesse.eth" that aren't in
 * ENSIP-15 normalized form). Docs without the field are treated as normalized, so only
 * the failures need writing — a few hundred docs, not a full reindex. Docs re-synced by
 * the WAL listener pick the field up on their own.
 *
 * Scans every ens_names row (read-only), adds the field to the mapping if missing, then
 * partially updates only the docs that fail.
 *
 * Dry run by default; pass --apply to write. Runs against whatever DATABASE_URL /
 * ELASTICSEARCH_URL the .env points at (prod, locally) — check the target it prints.
 *
 * Usage:
 *   npm run backfill-is-normalized:dry
 *   npm run backfill-is-normalized
 */

import { getElasticsearchClient, getPostgresPool, closeAllConnections, config, isNormalizedName } from '../../../shared/src';

const BATCH_SIZE = 50000;
const ES_BULK_SIZE = 500;

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

  // 1. Find names that fail normalization
  const failing: Array<{ id: number; name: string }> = [];
  let lastId = 0;
  let scanned = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM ens_names WHERE id > $1 ORDER BY id LIMIT $2',
      [lastId, BATCH_SIZE]
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (isNormalizedName(row.name) === false) failing.push(row);
    }
    scanned += rows.length;
    lastId = rows[rows.length - 1].id;
    process.stdout.write(`\rScanned ${scanned} names, ${failing.length} not normalized`);
  }
  console.log('\n');

  const shown = failing.filter((r) => !/\..+\.eth$/.test(r.name));
  console.log(`${failing.length} not normalized (${failing.length - shown.length} subnames, already hidden from search)`);
  console.log('Second-level names that will be hidden:');
  for (const r of shown) console.log(`  ${r.id}\t${JSON.stringify(r.name)}`);

  if (!apply) {
    console.log('\nDry run — nothing written.');
    return;
  }

  // 2. Make sure the mapping has the field (the WAL listener also adds it on startup)
  const mapping: any = await es.indices.getMapping({ index });
  const properties = (Object.values(mapping)[0] as any)?.mappings?.properties ?? {};
  if (!properties.is_normalized) {
    await es.indices.putMapping({ index, body: { properties: { is_normalized: { type: 'boolean' } } } });
    console.log('\nAdded is_normalized to the mapping');
  }

  // 3. Partial-update only the failing docs
  let updated = 0;
  let missing = 0;
  let errors = 0;
  for (let i = 0; i < failing.length; i += ES_BULK_SIZE) {
    const chunk = failing.slice(i, i + ES_BULK_SIZE);
    const body = chunk.flatMap((r) => [
      { update: { _index: index, _id: r.id.toString() } },
      { doc: { is_normalized: false } },
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
  }

  console.log(`\nUpdated ${updated} docs, ${missing} not in the index, ${errors} errors`);

  // Bulk returns per-doc failures without throwing; those names stay visible in search
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
