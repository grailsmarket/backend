/**
 * FAST Elasticsearch Resync Script
 *
 * Optimized for bulk reindexing 3.5M+ ENS names
 *
 * Optimizations:
 * - Large batch sizes (5000 records)
 * - Parallel processing
 * - Minimal delays
 * - Refresh disabled during indexing
 * - Progress tracking
 *
 * Usage:
 *   npm run resync:fast
 */

import { getElasticsearchClient, getPostgresPool, config, closeAllConnections, hasEmoji } from '../../../shared/src';

const esClient = getElasticsearchClient();
const pool = getPostgresPool();

const BATCH_SIZE = 200; // Small batches to avoid ES timeouts
const CONCURRENT_BATCHES = 10; // Parallel batches with staggered starts

function generateTags(name: string): string[] {
  const tags: string[] = [];
  const cleanName = name.replace('.eth', '');

  if (cleanName.length <= 3) tags.push('short');
  if (cleanName.length === 4) tags.push('4-letter');
  if (cleanName.length === 5) tags.push('5-letter');
  if (/^\d+$/.test(cleanName)) tags.push('numeric');
  if (/^[a-z]+$/i.test(cleanName)) tags.push('alphabetic');
  if (hasEmoji(cleanName)) {
    tags.push('emoji');
  }

  return tags;
}

async function processBatch(offset: number, batchSize: number, totalRows: number): Promise<number> {
  // MUCH simpler query - just get the ENS names, no JOINs
  // We can live without listing/offer data for now - huge speedup
  const query = `
    SELECT *
    FROM ens_names
    ORDER BY updated_at DESC
    LIMIT $1 OFFSET $2
  `;

  const result = await pool.query(query, [batchSize, offset]);

  if (result.rows.length === 0) {
    return 0;
  }

  // Build bulk body - minimal enrichment, no listings/offers
  const bulkBody = [];
  for (const row of result.rows) {
    const name = row.name || '';
    const cleanName = name.replace('.eth', '');

    const enrichedData = {
      name,
      token_id: row.token_id,
      owner: row.owner_address,
      price: null, // No listing data for new imports
      expiry_date: row.expiry_date,
      registration_date: row.registration_date,
      character_count: cleanName.length,
      has_numbers: row.has_numbers !== null ? row.has_numbers : /\d/.test(name),
      has_emoji: row.has_emoji !== null ? row.has_emoji : hasEmoji(name),
      status: 'unlisted',
      tags: generateTags(name),
      clubs: row.clubs || [],
      last_sale_price: row.last_sale_price ? parseFloat(row.last_sale_price) : null,
      last_sale_currency: row.last_sale_currency,
      last_sale_price_usd: row.last_sale_price_usd,
      listing_created_at: null,
      active_offers_count: 0,
      highest_offer: row.highest_offer_wei ? parseFloat(row.highest_offer_wei) : null,
      is_expired: false,
      is_grace_period: false,
      is_premium_period: false,
      days_until_expiry: null,
      premium_amount_eth: null,
      last_sale_date: row.last_sale_date,
      has_sales: !!row.last_sale_date,
      days_since_last_sale: null,
    };

    bulkBody.push({ index: { _index: config.elasticsearch.index, _id: row.id.toString() } });
    bulkBody.push(enrichedData);
  }

  // Send to Elasticsearch
  const response = await esClient.bulk({
    body: bulkBody,
    timeout: '300s', // 5 minutes timeout for large batches
    refresh: false, // Don't refresh after each batch - HUGE speedup
  });

  if (response.errors) {
    const errors = response.items?.filter((item: any) => item.index?.error);
    console.error(`Batch had ${errors?.length || 0} errors. First error:`, errors?.[0]?.index?.error);
  }

  const endRange = Math.min(offset + result.rows.length, totalRows);
  const percentage = ((endRange / totalRows) * 100).toFixed(1);
  console.log(`[${percentage}%] Indexed ${offset + 1}-${endRange} of ${totalRows.toLocaleString()}`);

  return result.rows.length;
}

async function fastResync() {
  console.log('\n========================================');
  console.log('FAST Elasticsearch Resync');
  console.log('========================================\n');

  const startTime = Date.now();

  try {
    // Test connection
    await esClient.ping();
    console.log('✓ Connected to Elasticsearch\n');

    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) as total FROM ens_names');
    const totalRows = parseInt(countResult.rows[0].total);
    console.log(`Total ENS names to sync: ${totalRows.toLocaleString()}\n`);

    // Disable refresh for speed
    console.log('Optimizing index settings for bulk import...');
    await esClient.indices.putSettings({
      index: config.elasticsearch.index,
      body: {
        index: {
          refresh_interval: '-1', // Disable auto-refresh
          number_of_replicas: 0,   // Disable replicas during import
        },
      },
    }).catch(() => {
      console.log('Note: Could not adjust settings (index might not exist yet)');
    });

    console.log(`Batch size: ${BATCH_SIZE.toLocaleString()}`);
    console.log(`Concurrent batches: ${CONCURRENT_BATCHES}\n`);
    console.log('Starting bulk indexing...\n');

    let processed = 0;
    let offset = 0;

    // Process batches with limited concurrency
    while (offset < totalRows) {
      const batchPromises: Promise<number>[] = [];

      // Launch concurrent batches with staggered start
      for (let i = 0; i < CONCURRENT_BATCHES && offset < totalRows; i++) {
        batchPromises.push(processBatch(offset, BATCH_SIZE, totalRows));
        offset += BATCH_SIZE;

        // Stagger the start of each batch by 10 seconds to avoid overwhelming ES
        // if (i < CONCURRENT_BATCHES - 1 && offset < totalRows) {
        //   await new Promise(resolve => setTimeout(resolve, 10000));
        // }
      }

      // Wait for all concurrent batches to complete
      const results = await Promise.all(batchPromises);
      processed += results.reduce((sum, count) => sum + count, 0);

      // Small delay between batch groups
      if (offset < totalRows) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Re-enable refresh and force refresh
    console.log('\n\nRestoring index settings and refreshing...');
    await esClient.indices.putSettings({
      index: config.elasticsearch.index,
      body: {
        index: {
          refresh_interval: '1s', // Restore default
          number_of_replicas: 1,   // Restore replicas
        },
      },
    });

    await esClient.indices.refresh({ index: config.elasticsearch.index });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = Math.round(processed / parseFloat(duration));

    console.log('\n========================================');
    console.log('RESYNC COMPLETE!');
    console.log('========================================');
    console.log(`Total indexed:     ${processed.toLocaleString()}`);
    console.log(`Time elapsed:      ${duration}s`);
    console.log(`Average rate:      ${rate.toLocaleString()} docs/sec`);
    console.log('========================================\n');

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Resync failed:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

fastResync();
