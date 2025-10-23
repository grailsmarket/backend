#!/usr/bin/env node --max-old-space-size=2048
/**
 * Backfill ENS Names Script
 *
 * This script resolves placeholder "token-*" names to their actual ENS names
 * using The Graph API, and fetches metadata (avatar, description, social links)
 * from the blockchain. It processes names in batches to avoid overwhelming
 * the API and provides progress updates.
 *
 * Usage:
 *   node --max-old-space-size=2048 --expose-gc --loader tsx src/scripts/backfill-ens-names.ts [--batch-size 25] [--limit 10000]
 *
 * Options:
 *   --batch-size: Number of names to resolve per batch (default: 25)
 *   --limit: Max total names to process in this run (default: unlimited)
 *   --delay: Delay between batches in ms (default: 2000)
 *   --skip-metadata: Skip fetching metadata (only resolve names)
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ethers } from 'ethers';

const pool = getPostgresPool();

interface BackfillStats {
  total: number;
  processed: number;
  resolved: number;
  failed: number;
  skipped: number;
  metadataFetched: number;
  metadataFailed: number;
  duplicatesDeleted: number;
}

interface ENSMetadata {
  avatar?: string;
  description?: string;
  url?: string;
  twitter?: string;
  github?: string;
  email?: string;
  discord?: string;
  telegram?: string;
  resolverAddress?: string;
}

/**
 * Resolve token IDs to ENS names using The Graph (cache-free version for this script)
 */
async function resolveTokenIdsBatch(tokenIds: string[]): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  if (tokenIds.length === 0) {
    return results;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    // Convert all token IDs to labelhashes with proper padding
    const labelhashes = tokenIds.map(id => {
      const hexString = BigInt(id).toString(16).padStart(64, '0');
      return '0x' + hexString;
    });

    const query = `
      query GetENSNames($labelhashes: [String!]!) {
        domains(where: { labelhash_in: $labelhashes }) {
          id
          name
          labelName
          labelhash
        }
      }
    `;

    const headers: any = {
      'Content-Type': 'application/json',
    };

    if (config.theGraph.apiKey) {
      headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
    }

    const response = await fetch(config.theGraph.ensSubgraphUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { labelhashes }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`    ⚠️  Graph API error: ${response.status} ${response.statusText}`);
      // Return nulls for all items
      for (const tokenId of tokenIds) {
        results.set(tokenId, null);
      }
      return results;
    }

    const data = await response.json() as any;

    if (data.errors) {
      console.log(`    ⚠️  Graph query errors: ${JSON.stringify(data.errors)}`);
      // Return nulls for all items
      for (const tokenId of tokenIds) {
        results.set(tokenId, null);
      }
      return results;
    }

    const domains = data.data?.domains || [];

    // Create a map of labelhash to domain (reuse labelhash calculation)
    const domainMap = new Map<string, any>();
    for (const domain of domains) {
      if (domain.labelhash) {
        domainMap.set(domain.labelhash.toLowerCase(), domain);
      }
    }

    // Process results - map back to original token IDs
    for (let i = 0; i < tokenIds.length; i++) {
      const tokenId = tokenIds[i];
      const labelhash = labelhashes[i].toLowerCase(); // Reuse already calculated labelhash
      const domain = domainMap.get(labelhash);

      if (domain) {
        const name = domain.name || domain.labelName;
        results.set(tokenId, name || null);
      } else {
        results.set(tokenId, null);
      }
    }

    return results;

  } catch (error: any) {
    clearTimeout(timeoutId);
    console.log(`    ⚠️  Failed to resolve batch: ${error.message}`);
    // Return nulls for all items
    for (const tokenId of tokenIds) {
      results.set(tokenId, null);
    }
    return results;
  }
}

/**
 * Fetch metadata for multiple names using Enstate bulk API
 * Chunks requests to avoid OOM on large batches
 */
async function fetchMetadataBatch(
  names: string[],
  timeoutMs: number = 10000,
  chunkSize: number = 10  // Reduced to 10 to minimize memory usage
): Promise<Map<string, ENSMetadata | null>> {
  const results = new Map<string, ENSMetadata | null>();

  if (names.length === 0) {
    return results;
  }

  // Process in chunks to avoid large JSON responses causing OOM
  for (let i = 0; i < names.length; i += chunkSize) {
    const chunk = names.slice(i, i + chunkSize);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Build URL with query parameters
      const params = new URLSearchParams();
      chunk.forEach(name => {
        params.append('queries[]', name);
      });

      const response = await fetch(
        `https://enstate-prod-us-east-1.up.railway.app/bulk/u?${params.toString()}`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.log(`    ⚠️  Bulk metadata fetch failed: ${response.status}`);
        continue;
      }

      const data: any = await response.json();

      // Process each response entry
      if (data.response && Array.isArray(data.response)) {
        for (const entry of data.response) {
          if (entry.type === 'success' && entry.name) {
            const metadata: ENSMetadata = {};

            // Map Enstate bulk response to our metadata format
            if (entry.avatar) metadata.avatar = entry.avatar;
            if (entry.records?.description) metadata.description = entry.records.description;
            if (entry.records?.url) metadata.url = entry.records.url;
            if (entry.records?.['com.twitter']) metadata.twitter = entry.records['com.twitter'];
            if (entry.records?.['com.github']) metadata.github = entry.records['com.github'];
            if (entry.records?.email) metadata.email = entry.records.email;
            if (entry.records?.['com.discord']) metadata.discord = entry.records['com.discord'];
            if (entry.records?.['org.telegram']) metadata.telegram = entry.records['org.telegram'];

            results.set(entry.name, metadata);
          }
        }
      }

      // Small delay between metadata chunks
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error: any) {
      clearTimeout(timeoutId);
      console.log(`    ⚠️  Bulk metadata fetch error: ${error.message}`);
    }
  }

  return results;
}

async function backfillENSNames(batchSize: number = 100, maxLimit?: number, delayMs: number = 1000, skipMetadata: boolean = false) {
  const stats: BackfillStats = {
    total: 0,
    processed: 0,
    resolved: 0,
    failed: 0,
    skipped: 0,
    metadataFetched: 0,
    metadataFailed: 0,
    duplicatesDeleted: 0,
  };



  try {
    // Get total count of placeholder names
    const countResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM ens_names
      WHERE name LIKE 'token-%'
    `);

    stats.total = parseInt(countResult.rows[0].count);

    console.log('\n=== ENS Name Backfill ===');
    console.log(`Total placeholder names: ${stats.total.toLocaleString()}`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Delay between batches: ${delayMs}ms`);
    console.log(`Fetch metadata: ${!skipMetadata ? 'Yes' : 'No (--skip-metadata)'}`);
    if (maxLimit) {
      console.log(`Limit: ${maxLimit.toLocaleString()}`);
    }
    console.log('========================\n');

    const limitToProcess = maxLimit || stats.total;
    let batchNumber = 0;
    let lastProcessedId: number | null = null;

    while (stats.processed < limitToProcess) {
      batchNumber++;

      // Fetch a batch of placeholder names using cursor-based pagination (safer than OFFSET)
      // This prevents pagination issues when records are deleted during processing
      const currentBatchSize = maxLimit ? Math.min(batchSize, maxLimit - stats.processed) : batchSize;

      const batchResult: any = lastProcessedId === null
        ? await pool.query(`
            SELECT id, token_id, name
            FROM ens_names
            WHERE name LIKE 'token-%'
            ORDER BY id DESC
            LIMIT ${currentBatchSize}
          `)
        : await pool.query(`
            SELECT id, token_id, name
            FROM ens_names
            WHERE name LIKE 'token-%' AND id < ${lastProcessedId}
            ORDER BY id DESC
            LIMIT ${currentBatchSize}
          `);

      const batch: any[] = batchResult.rows;

      if (batch.length === 0) {
        break;
      }

      console.log(`\nProcessing batch ${batchNumber} (${batch.length} records)...`);

      // Update cursor for next iteration
      lastProcessedId = batch[batch.length - 1].id;

      // Extract token IDs for batch resolution
      const tokenIds = batch.map((row: any) => row.token_id);

      try {
        // Resolve all names in this batch using The Graph (cache-free)
        const resolvedNames = await resolveTokenIdsBatch(tokenIds);

        // Process updates in a single transaction to reduce connection overhead
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          for (const row of batch) {
            const resolvedName = resolvedNames.get(row.token_id);

            if (resolvedName && resolvedName !== row.name) {
              try {
                // Calculate attributes for the resolved name
                const has_numbers = /\d/.test(resolvedName);
                const has_emoji = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(resolvedName);

                // Check if this name already exists (different token_id)
                const existingName = await client.query(
                  'SELECT id FROM ens_names WHERE name = $1 AND id != $2',
                  [resolvedName, row.id]
                );

                if (existingName.rows.length > 0) {
                  // Delete duplicate placeholder
                  await client.query(
                    'DELETE FROM ens_names WHERE id = $1',
                    [row.id]
                  );
                  stats.duplicatesDeleted++;
                } else {
                  // Update the placeholder name
                  await client.query(
                    'UPDATE ens_names SET name = $1, has_numbers = $2, has_emoji = $3, updated_at = NOW() WHERE id = $4',
                    [resolvedName, has_numbers, has_emoji, row.id]
                  );
                  stats.resolved++;
                }
              } catch (error: any) {
                stats.failed++;
              }
            } else {
              stats.skipped++;
            }

            stats.processed++;
          }

          await client.query('COMMIT');
        } catch (error: any) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        // Clear the Maps explicitly
        resolvedNames.clear();

      } catch (error: any) {
        console.error(`  ✗ Batch failed: ${error.message}`);
        stats.failed += batch.length;
        stats.processed += batch.length;
      }

      // Progress update (simplified to reduce memory)
      console.log(`Batch ${batchNumber}: ${stats.processed}/${limitToProcess} | Resolved: ${stats.resolved} | Skipped: ${stats.skipped} | Dupes: ${stats.duplicatesDeleted}`);

      // Clear batch array to help GC
      batch.length = 0;

      // Force garbage collection hint (V8 will GC if needed)
      if (global.gc) {
        global.gc();
      }

      // Delay between batches
      if (stats.processed < limitToProcess) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    console.log('\n=== Backfill Complete ===');
    console.log(`Total processed: ${stats.processed.toLocaleString()}`);
    console.log(`Successfully resolved: ${stats.resolved.toLocaleString()}`);
    console.log(`Skipped: ${stats.skipped.toLocaleString()}`);
    console.log(`Failed: ${stats.failed.toLocaleString()}`);
    console.log(`Duplicates deleted: ${stats.duplicatesDeleted.toLocaleString()}`);
    if (!skipMetadata) {
      console.log(`\nMetadata Stats:`);
      console.log(`  Fetched: ${stats.metadataFetched.toLocaleString()}`);
      console.log(`  Failed: ${stats.metadataFailed.toLocaleString()}`);
    }
    console.log('=========================\n');

    if (stats.resolved > 0) {
      console.log('⚠️  Don\'t forget to resync Elasticsearch:');
      console.log('   cd ../wal-listener && npm run resync\n');
    }

  } catch (error: any) {
    console.error('Error during backfill:', error);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);

  let batchSize = 10;  // Very small batches to prevent OOM
  let maxLimit: number | undefined;
  let delayMs = 3000;  // Longer delay to allow GC between batches
  let skipMetadata = true;  // Skip metadata by default due to memory issues

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      maxLimit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
      delayMs = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--skip-metadata') {
      skipMetadata = true;
    }
  }

  try {
    await backfillENSNames(batchSize, maxLimit, delayMs, skipMetadata);
    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
