#!/usr/bin/env tsx
/**
 * Recreate Elasticsearch Index with New Mapping
 *
 * This script:
 * 1. Deletes the existing ens_names index
 * 2. Creates a new index with the updated mapping (double instead of scaled_float)
 * 3. Ready for full resync
 *
 * Usage:
 *   npx tsx src/scripts/recreate-es-index.ts
 */

import { getElasticsearchClient, closeAllConnections } from '../../../shared/src';
import { ElasticsearchSync } from '../services/elasticsearch-sync';

const es = getElasticsearchClient();

async function main() {
  console.log('🔄 Recreating Elasticsearch index with new mapping...\n');

  try {
    // Check if index exists
    const indexExists = await es.indices.exists({ index: 'ens_names' });

    if (indexExists) {
      console.log('📊 Current index exists. Deleting...');
      await es.indices.delete({ index: 'ens_names' });
      console.log('✅ Index deleted successfully\n');
    } else {
      console.log('ℹ️  Index does not exist, will create new one\n');
    }

    // Create new index with updated mapping
    console.log('🔨 Creating new index with updated mapping (double type for prices)...');
    const sync = new ElasticsearchSync();

    try {
      await sync.createIndex();
      console.log('✅ Index created successfully with new mapping\n');
    } catch (error: any) {
      if (error.message.includes('resource_already_exists_exception')) {
        console.log('ℹ️  Index already exists (likely recreated by WAL listener)\n');
        console.log('⚠️  Please stop the WAL listener service and run this script again.\n');
        console.log('   Or manually delete the index and let this script recreate it.\n');
      } else {
        throw error;
      }
    }

    console.log('📝 New mapping details:');
    console.log('   - price: double (was scaled_float)');
    console.log('   - last_sale_price: double (was scaled_float)');
    console.log('   - highest_offer: double (was scaled_float)');
    console.log('   - Values stored in wei (not divided by 1e18)\n');

    console.log('✨ Index recreation complete!\n');
    console.log('💡 Next steps:');
    console.log('   1. Run: npm run resync');
    console.log('   2. Or run: npx tsx src/scripts/resync-elasticsearch.ts');
    console.log('   This will repopulate all ENS names with the new mapping.\n');

    await closeAllConnections();
    process.exit(0);
  } catch (error: any) {
    console.error('💥 Error:', error.message);
    console.error(error.stack);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
