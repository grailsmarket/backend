/**
 * Cleanup Orphaned Elasticsearch Documents
 *
 * Finds and removes ES documents whose IDs don't exist in PostgreSQL.
 * This can happen when records are deleted from PostgreSQL but the
 * WAL listener wasn't running to catch the DELETE events.
 *
 * Usage:
 *   npm run cleanup-orphans          # Actually delete orphans
 *   npm run cleanup-orphans:dry      # Dry run - just report what would be deleted
 */

import { getElasticsearchClient, getPostgresPool, config, closeAllConnections } from '../../../shared/src';

const esClient = getElasticsearchClient();
const pool = getPostgresPool();

const ES_BATCH_SIZE = 5000; // How many IDs to fetch from ES at a time
const PG_BATCH_SIZE = 1000; // How many IDs to check against PostgreSQL at a time
const DELETE_BATCH_SIZE = 500; // How many documents to delete at a time

const isDryRun = process.argv.includes('--dry-run');

async function getESDocumentIds(scrollId?: string): Promise<{ ids: string[]; scrollId: string | null; total: number }> {
  if (scrollId) {
    const response = await esClient.scroll({
      scroll_id: scrollId,
      scroll: '2m',
    });

    const ids = response.hits.hits.map((hit: any) => hit._id);
    const newScrollId = ids.length > 0 ? response._scroll_id : null;

    return { ids, scrollId: newScrollId || null, total: 0 };
  }

  // Initial search with scroll
  const response = await esClient.search({
    index: config.elasticsearch.index,
    scroll: '2m',
    size: ES_BATCH_SIZE,
    body: {
      query: { match_all: {} },
      _source: false, // We only need IDs
    },
  });

  const ids = response.hits.hits.map((hit: any) => hit._id);
  const total = typeof response.hits.total === 'object' ? response.hits.total.value : (response.hits.total || 0);

  return {
    ids,
    scrollId: response._scroll_id || null,
    total: total as number,
  };
}

async function checkIdsExistInPostgres(ids: string[]): Promise<Set<string>> {
  // Convert string IDs to numbers for PostgreSQL query
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

  if (numericIds.length === 0) {
    return new Set();
  }

  const result = await pool.query(
    'SELECT id::text FROM ens_names WHERE id = ANY($1::int[])',
    [numericIds]
  );

  return new Set(result.rows.map(row => row.id));
}

async function deleteFromES(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const bulkBody = ids.flatMap(id => [
    { delete: { _index: config.elasticsearch.index, _id: id } }
  ]);

  const response = await esClient.bulk({
    body: bulkBody,
    refresh: false,
  });

  const deleted = response.items.filter((item: any) =>
    item.delete?.status === 200 || item.delete?.status === 404
  ).length;

  return deleted;
}

async function cleanup() {
  console.log('\n========================================');
  console.log('Elasticsearch Orphan Cleanup');
  console.log(isDryRun ? '(DRY RUN - no changes will be made)' : '(LIVE RUN - will delete orphans)');
  console.log('========================================\n');

  const startTime = Date.now();

  try {
    // Test connections
    await esClient.ping();
    console.log('✓ Connected to Elasticsearch');
    await pool.query('SELECT 1');
    console.log('✓ Connected to PostgreSQL\n');

    // Get counts
    const esCountResult = await esClient.count({ index: config.elasticsearch.index });
    const esCount = esCountResult.count;
    const pgCountResult = await pool.query('SELECT COUNT(*)::int as count FROM ens_names');
    const pgCount = pgCountResult.rows[0].count;

    console.log(`Elasticsearch documents: ${esCount.toLocaleString()}`);
    console.log(`PostgreSQL records:      ${pgCount.toLocaleString()}`);
    console.log(`Expected orphans:        ~${(esCount - pgCount).toLocaleString()}\n`);

    let processedFromES = 0;
    let orphansFound = 0;
    let orphansDeleted = 0;
    let scrollId: string | null = null;
    const orphanIds: string[] = [];

    console.log('Scanning Elasticsearch documents...\n');

    // Scroll through all ES documents
    while (true) {
      const { ids, scrollId: newScrollId, total } = await getESDocumentIds(scrollId || undefined);

      if (ids.length === 0) {
        break;
      }

      scrollId = newScrollId;

      // Check IDs against PostgreSQL in batches
      for (let i = 0; i < ids.length; i += PG_BATCH_SIZE) {
        const batch = ids.slice(i, i + PG_BATCH_SIZE);
        const existingIds = await checkIdsExistInPostgres(batch);

        // Find orphans (IDs that don't exist in PostgreSQL)
        for (const id of batch) {
          if (!existingIds.has(id)) {
            orphanIds.push(id);
            orphansFound++;
          }
        }
      }

      processedFromES += ids.length;
      const percentage = ((processedFromES / esCount) * 100).toFixed(1);
      process.stdout.write(`\r[${percentage}%] Scanned ${processedFromES.toLocaleString()}/${esCount.toLocaleString()} - Found ${orphansFound.toLocaleString()} orphans`);

      // Delete orphans in batches as we go (to avoid memory issues)
      if (!isDryRun && orphanIds.length >= DELETE_BATCH_SIZE) {
        const toDelete = orphanIds.splice(0, DELETE_BATCH_SIZE);
        const deleted = await deleteFromES(toDelete);
        orphansDeleted += deleted;
      }
    }

    // Clear the scroll context
    if (scrollId) {
      await esClient.clearScroll({ scroll_id: scrollId }).catch(() => {});
    }

    console.log('\n');

    // Delete remaining orphans
    if (!isDryRun && orphanIds.length > 0) {
      console.log(`Deleting final batch of ${orphanIds.length} orphans...`);
      for (let i = 0; i < orphanIds.length; i += DELETE_BATCH_SIZE) {
        const batch = orphanIds.slice(i, i + DELETE_BATCH_SIZE);
        const deleted = await deleteFromES(batch);
        orphansDeleted += deleted;
      }
    }

    // Refresh the index
    if (!isDryRun && orphansDeleted > 0) {
      console.log('Refreshing index...');
      await esClient.indices.refresh({ index: config.elasticsearch.index });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n========================================');
    console.log('CLEANUP COMPLETE');
    console.log('========================================');
    console.log(`Documents scanned:  ${processedFromES.toLocaleString()}`);
    console.log(`Orphans found:      ${orphansFound.toLocaleString()}`);
    if (isDryRun) {
      console.log(`Orphans to delete:  ${orphansFound.toLocaleString()} (dry run)`);
    } else {
      console.log(`Orphans deleted:    ${orphansDeleted.toLocaleString()}`);
    }
    console.log(`Time elapsed:       ${duration}s`);
    console.log('========================================\n');

    if (isDryRun && orphansFound > 0) {
      console.log('Run without --dry-run to actually delete the orphans.\n');
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Cleanup failed:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

cleanup();
