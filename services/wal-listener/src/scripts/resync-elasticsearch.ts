#!/usr/bin/env tsx
/**
 * Elasticsearch Resync Script
 *
 * Resyncs all ENS names from PostgreSQL to Elasticsearch.
 * Use this after making bulk changes to the database (e.g., adding clubs).
 *
 * Usage:
 *   npx tsx src/scripts/resync-elasticsearch.ts
 */

import { ElasticsearchSync } from '../services/elasticsearch-sync';
import { closeAllConnections } from '../../../shared/src';

async function resync() {
  console.log('Starting Elasticsearch resync...\n');

  try {
    const sync = new ElasticsearchSync();

    // Ensure index exists with correct mappings
    await sync.createIndex();

    // Perform bulk sync
    await sync.bulkSync();

    console.log('\n✓ Elasticsearch resync complete!');

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Elasticsearch resync failed:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

resync();
