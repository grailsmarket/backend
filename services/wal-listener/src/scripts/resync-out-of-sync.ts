#!/usr/bin/env tsx
/**
 * Resync Out-of-Sync Records
 *
 * Finds records that are out of sync between Elasticsearch and PostgreSQL,
 * then resyncs only those records.
 *
 * Detection criteria:
 * - ES shows status: active but PostgreSQL has no active listing
 * - ES has placeholder names (token-*) but PostgreSQL has real names
 * - ES document IDs that don't exist in PostgreSQL (orphaned records)
 *
 * Usage:
 *   npx tsx src/scripts/resync-out-of-sync.ts
 */

import { getPostgresPool, getElasticsearchClient, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

const pool = getPostgresPool();
const es = getElasticsearchClient();

async function findOutOfSyncRecords() {
  console.log('🔍 Finding records with stale active status...\n');

  const outOfSync: number[] = [];
  const toDelete: string[] = []; // ES document IDs to delete

  // Step 1: Find records in ES with status: active
  console.log('Step 1: Querying ES for records with status: active...');

  let scrollId: string | undefined;
  let totalChecked = 0;
  let hasMore = true;

  // Initial search with scroll
  const searchResponse = await es.search({
    index: 'ens_names',
    scroll: '2m',
    size: 1000,
    body: {
      query: {
        term: { status: 'active' }
      },
      _source: ['name']
    }
  });

  scrollId = searchResponse._scroll_id;
  let hits = searchResponse.hits.hits;

  while (hasMore && hits.length > 0) {
    // Extract IDs from this batch
    const esIds = hits.map((hit: any) => parseInt(hit._id));
    totalChecked += esIds.length;

    console.log(`  Checking batch of ${esIds.length} records (${totalChecked} total checked)...`);

    // First, check which IDs exist in PostgreSQL at all
    const pgExistsResult = await pool.query(
      'SELECT id FROM ens_names WHERE id = ANY($1)',
      [esIds]
    );
    const pgExistingIds = new Set(pgExistsResult.rows.map(row => row.id));

    // Find orphaned records (ES ID doesn't exist in PG)
    for (const hit of hits) {
      if (!hit._id) continue;
      const esId = parseInt(hit._id);
      if (!pgExistingIds.has(esId)) {
        toDelete.push(hit._id);
        const name = (hit._source as any).name;
        console.log(`    ✗ Orphaned: ID ${hit._id} (${name}) - not in PG`);
      }
    }

    // For records that exist in PG, check which ones actually have active listings
    const existingIds = esIds.filter(id => pgExistingIds.has(id));

    if (existingIds.length > 0) {
      const pgResult = await pool.query(
        `SELECT DISTINCT ens_name_id
         FROM listings
         WHERE ens_name_id = ANY($1)
         AND status = 'active'`,
        [existingIds]
      );

      const pgIdsWithListings = new Set(pgResult.rows.map(row => row.ens_name_id));

      // Find records that ES thinks have listings but PostgreSQL doesn't
      for (const id of existingIds) {
        if (!pgIdsWithListings.has(id)) {
          outOfSync.push(id);
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

      if (hits.length === 0) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }

  // Clear scroll
  if (scrollId) {
    await es.clearScroll({ scroll_id: scrollId });
  }

  console.log(`\n✓ Found ${outOfSync.length} records with stale active status (out of ${totalChecked} checked)`);

  // Step 2: Find placeholder names that don't exist in PostgreSQL
  console.log('\nStep 2: Querying ES for placeholder names (token-*)...');

  let placeholderScrollId: string | undefined;
  let placeholderChecked = 0;

  const placeholderSearch = await es.search({
    index: 'ens_names',
    scroll: '2m',
    size: 1000,
    body: {
      query: {
        prefix: { 'name.keyword': 'token-' }
      },
      _source: ['name', 'token_id']
    }
  });

  placeholderScrollId = placeholderSearch._scroll_id;
  let placeholderHits = placeholderSearch.hits.hits;

  while (placeholderHits.length > 0) {
    const esData = placeholderHits.map((hit: any) => ({
      esId: hit._id,
      dbId: parseInt(hit._id),
      tokenId: hit._source.token_id,
      name: hit._source.name
    }));

    placeholderChecked += esData.length;
    console.log(`  Checking batch of ${esData.length} placeholder records (${placeholderChecked} total)...`);

    // Check which token_ids exist in PostgreSQL and get their correct IDs
    const dbIds = esData.map(d => d.dbId);
    const tokenIds = esData.map(d => d.tokenId);

    const pgResult = await pool.query(
      `SELECT id, token_id FROM ens_names WHERE id = ANY($1) OR token_id = ANY($2)`,
      [dbIds, tokenIds]
    );

    // Map token_id -> correct PostgreSQL ID
    const tokenIdToCorrectId = new Map<string, number>();
    for (const row of pgResult.rows) {
      tokenIdToCorrectId.set(row.token_id, row.id);
    }

    // Find placeholders that should be deleted
    for (const data of esData) {
      const correctId = tokenIdToCorrectId.get(data.tokenId);

      if (!correctId) {
        // Token doesn't exist in PostgreSQL at all - delete it
        toDelete.push(data.esId);
      } else if (correctId !== data.dbId) {
        // Token exists but ES has wrong ID - delete this stale document
        // (The correct ID will have the proper record in ES)
        toDelete.push(data.esId);
      }
      // If correctId === data.dbId, it's just a placeholder that needs updating (not deleting)
    }

    // Get next batch
    if (placeholderScrollId) {
      const scrollResponse = await es.scroll({
        scroll_id: placeholderScrollId,
        scroll: '2m'
      });

      placeholderHits = scrollResponse.hits.hits;
      placeholderScrollId = scrollResponse._scroll_id;
    } else {
      break;
    }
  }

  // Clear scroll
  if (placeholderScrollId) {
    await es.clearScroll({ scroll_id: placeholderScrollId });
  }

  console.log(`\n✓ Found ${toDelete.length} placeholder records to delete (out of ${placeholderChecked} checked)`);

  return { outOfSync, toDelete };
}

async function resyncRecords(ids: number[]) {
  console.log(`\n📝 Resyncing ${ids.length} out-of-sync records...\n`);

  const sync = new ElasticsearchSync();
  const batchSize = 100;
  let synced = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);

    console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (${i + 1}-${Math.min(i + batchSize, ids.length)} of ${ids.length})...`);

    // Fetch records from PostgreSQL with all necessary joins
    const query = `
      SELECT
        en.*,
        l.price_wei as listing_price,
        l.status as listing_status,
        l.created_at as listing_created_at,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'pending') as active_offers_count
      FROM ens_names en
      LEFT JOIN LATERAL (
        SELECT * FROM listings
        WHERE listings.ens_name_id = en.id
        AND listings.status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      ) l ON true
      LEFT JOIN offers o ON o.ens_name_id = en.id
      WHERE en.id = ANY($1)
      GROUP BY en.id, l.price_wei, l.status, l.created_at
    `;

    const result = await pool.query(query, [batch]);

    // Update each record in Elasticsearch
    for (const row of result.rows) {
      try {
        await sync.updateENSNameListing(row.id);
        synced++;
      } catch (error: any) {
        console.error(`  ✗ Failed to sync ID ${row.id}: ${error.message}`);
      }
    }

    console.log(`  ✓ Synced ${synced}/${ids.length} records`);

    // Small delay to avoid overwhelming ES
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n✨ Resync complete! Updated ${synced} records.`);
}

async function deleteRecords(esIds: string[]) {
  console.log(`\n🗑️  Deleting ${esIds.length} orphaned placeholder records from ES...\n`);

  const batchSize = 1000;
  let deleted = 0;

  for (let i = 0; i < esIds.length; i += batchSize) {
    const batch = esIds.slice(i, i + batchSize);

    console.log(`Deleting batch ${Math.floor(i / batchSize) + 1} (${i + 1}-${Math.min(i + batchSize, esIds.length)} of ${esIds.length})...`);

    // Build bulk delete body
    const bulkBody = batch.flatMap(id => [
      { delete: { _index: 'ens_names', _id: id } }
    ]);

    try {
      const response = await es.bulk({ body: bulkBody });

      if (response.errors) {
        const errors = response.items?.filter((item: any) => item.delete?.error);
        console.error(`  ⚠️  Batch had ${errors?.length || 0} errors`);
      } else {
        deleted += batch.length;
        console.log(`  ✓ Deleted ${batch.length} records`);
      }
    } catch (error: any) {
      console.error(`  ✗ Failed to delete batch: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n✨ Deletion complete! Removed ${deleted} orphaned records from ES.`);
}

async function main() {
  try {
    const { outOfSync, toDelete } = await findOutOfSyncRecords();

    if (outOfSync.length === 0 && toDelete.length === 0) {
      console.log('\n✓ No out-of-sync records found! Everything is in sync.');
      await closeAllConnections();
      process.exit(0);
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Records to resync (stale status): ${outOfSync.length}`);
    console.log(`   Records to delete (orphaned/stale): ${toDelete.length}`);
    console.log('     - Orphaned (ID not in PG)')
    console.log('     - Placeholder duplicates')
    console.log('');

    // Delete orphaned placeholder records
    if (toDelete.length > 0) {
      await deleteRecords(toDelete);
    }

    // Resync the out-of-sync records
    if (outOfSync.length > 0) {
      await resyncRecords(outOfSync);
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error: any) {
    console.error('\n💥 Error:', error.message);
    console.error(error.stack);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
