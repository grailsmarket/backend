#!/usr/bin/env tsx
/**
 * Backfill ENS Names Script
 *
 * This script resolves placeholder "token-*" names to their actual ENS names
 * using The Graph API, and fetches metadata (avatar, description, social links)
 * from the blockchain. It processes names in batches to avoid overwhelming
 * the API and provides progress updates.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-ens-names.ts [--batch-size 100] [--limit 10000]
 *
 * Options:
 *   --batch-size: Number of names to resolve per Graph API call (default: 100)
 *   --limit: Max total names to process in this run (default: unlimited)
 *   --delay: Delay between batches in ms (default: 1000)
 *   --skip-metadata: Skip fetching blockchain metadata (only resolve names)
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import { ENSResolver } from '../services/ens-resolver';
import { logger } from '../utils/logger';
import { ethers } from 'ethers';

const pool = getPostgresPool();
const resolver = new ENSResolver();

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
 * Fetch ENS metadata from Enstate API
 */
async function fetchENSMetadata(ensName: string): Promise<ENSMetadata | null> {
  try {
    const response = await fetch(`https://enstate-prod-us-east-1.up.railway.app/u/${ensName}`);

    if (!response.ok) {
      return null;
    }

    const data:any = await response.json();

    const metadata: ENSMetadata = {};

    // Map Enstate response to our metadata format
    if (data.avatar) metadata.avatar = data.avatar;
    if (data.description) metadata.description = data.description;
    if (data.url) metadata.url = data.url;
    if (data.twitter) metadata.twitter = data.twitter;
    if (data.github) metadata.github = data.github;
    if (data.email) metadata.email = data.email;
    if (data.discord) metadata.discord = data.discord;
    if (data.telegram) metadata.telegram = data.telegram;

    return metadata;
  } catch (error) {
    return null;
  }
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
    let offset = 0;

    while (stats.processed < limitToProcess) {
      batchNumber++;

      // Fetch a batch of placeholder names, ordered by updated_at so we process oldest first
      // Use OFFSET to skip already processed records
      const currentBatchSize = maxLimit ? Math.min(batchSize, maxLimit - stats.processed) : batchSize;

      const batchResult = await pool.query(`
        SELECT id, token_id, name
        FROM ens_names
        WHERE name LIKE 'token-%'
        ORDER BY updated_at DESC, id DESC
        LIMIT ${currentBatchSize}
        OFFSET ${offset}
      `);

      const batch = batchResult.rows;

      if (batch.length === 0) {
        break;
      }

      console.log(`\nProcessing batch ${batchNumber} (${batch.length} records, offset ${offset})...`);

      offset += batch.length;

      // Extract token IDs for batch resolution
      const tokenIds = batch.map(row => row.token_id);

      try {
        // Resolve all names in this batch using The Graph
        const resolvedNames = await resolver.resolveBatch(tokenIds);

        // Update each name in the database
        for (const row of batch) {
          const resolvedName = resolvedNames.get(row.token_id);

          if (resolvedName && resolvedName !== row.name) {
            try {
              // Calculate attributes for the resolved name
              const has_numbers = /\d/.test(resolvedName);
              const has_emoji = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(resolvedName);

              // Fetch metadata if enabled
              let metadata: ENSMetadata | null = null;

              if (!skipMetadata) {
                try {
                  metadata = await fetchENSMetadata(resolvedName);
                  if (metadata) {
                    stats.metadataFetched++;
                  }
                } catch (metadataError: any) {
                  console.log(`    ⚠️  Metadata fetch failed: ${metadataError.message}`);
                  stats.metadataFailed++;
                }
              }

              // Check if this name already exists (different token_id)
              const existingName = await pool.query(
                'SELECT id, token_id, name FROM ens_names WHERE name = $1 AND id != $2',
                [resolvedName, row.id]
              );

              if (existingName.rows.length > 0) {
                // Name already exists with different token_id
                // Delete the current placeholder record since we already have the real name
                const deleteResult = await pool.query(
                  'DELETE FROM ens_names WHERE id = $1 AND name LIKE $2 RETURNING id',
                  [row.id, 'token-%']
                );

                if (deleteResult.rowCount && deleteResult.rowCount > 0) {
                  stats.duplicatesDeleted++;
                  console.log(`  🗑️  ${row.name} → ${resolvedName} - Deleted duplicate placeholder (kept id: ${existingName.rows[0].id})`);
                } else {
                  stats.skipped++;
                  console.log(`  ⊘ ${row.name} → ${resolvedName} - Name already exists (id: ${existingName.rows[0].id})`);
                }
              } else {
                // Safe to update - name doesn't exist or it's the same record
                if (metadata && Object.keys(metadata).length > 0) {
                  await pool.query(`
                    UPDATE ens_names
                    SET
                      name = $1,
                      has_numbers = $2,
                      has_emoji = $3,
                      metadata = $4,
                      updated_at = NOW()
                    WHERE id = $5
                  `, [resolvedName, has_numbers, has_emoji, JSON.stringify(metadata), row.id]);
                } else {
                  await pool.query(`
                    UPDATE ens_names
                    SET
                      name = $1,
                      has_numbers = $2,
                      has_emoji = $3,
                      updated_at = NOW()
                    WHERE id = $4
                  `, [resolvedName, has_numbers, has_emoji, row.id]);
                }

                stats.resolved++;
                const metadataInfo = metadata && Object.keys(metadata).length > 1 ? ' [+metadata]' : '';
                console.log(`  ✓ ${row.name} → ${resolvedName}${metadataInfo}`);
              }
            } catch (error: any) {
              stats.failed++;
              console.log(`  ✗ ${row.name} - Update failed: ${error.message}`);
            }
          } else if (!resolvedName) {
            stats.skipped++;
            console.log(`  ⊘ ${row.name} - No name found in subgraph`);
          } else {
            stats.skipped++;
            console.log(`  ⊘ ${row.name} - Already resolved`);
          }

          stats.processed++;
        }
      } catch (error: any) {
        console.error(`  ✗ Batch resolution failed: ${error.message}`);
        stats.failed += batch.length;
        stats.processed += batch.length;
      }

      // Progress update
      const percentComplete = ((stats.processed / limitToProcess) * 100).toFixed(1);
      const remainingCount = stats.total - (stats.resolved + stats.duplicatesDeleted);
      console.log(`\nProgress: ${stats.processed.toLocaleString()}/${limitToProcess.toLocaleString()} (${percentComplete}%) | Remaining placeholders: ~${remainingCount.toLocaleString()}`);
      console.log(`Resolved: ${stats.resolved.toLocaleString()} | Skipped: ${stats.skipped.toLocaleString()} | Failed: ${stats.failed.toLocaleString()} | Duplicates Deleted: ${stats.duplicatesDeleted.toLocaleString()}`);
      if (!skipMetadata) {
        console.log(`Metadata: ${stats.metadataFetched.toLocaleString()} fetched | ${stats.metadataFailed.toLocaleString()} failed`);
      }

      // Clear cache to prevent memory buildup
      resolver.clearCache();

      // Delay between batches to avoid overwhelming the API
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

  let batchSize = 100;
  let maxLimit: number | undefined;
  let delayMs = 1000;
  let skipMetadata = false;

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
