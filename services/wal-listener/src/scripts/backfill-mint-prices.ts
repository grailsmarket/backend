#!/usr/bin/env tsx
/**
 * Backfill Mint Prices from Registrations
 *
 * This script enriches mint events in activity_history with cost data from the registrations table:
 * 1. Sets price_wei to the registration's total_cost_wei
 * 2. Adds registration_id to the event's metadata
 *
 * Matching strategy:
 * - Primary: Match by ens_name_id + transaction_hash (most accurate)
 * - Fallback: Match by ens_name_id + closest block_number
 *
 * Usage:
 *   npx tsx src/scripts/backfill-mint-prices.ts [options]
 *
 * Options:
 *   --dry-run       Preview changes without modifying the database
 *   --batch-size=N  Number of records to process per batch (default: 100)
 *   --verbose       Show detailed logging for each record
 *   --resume        Resume from last saved progress
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import * as fs from 'fs/promises';
import * as path from 'path';

const pool = getPostgresPool();
const PROGRESS_FILE = path.join(process.cwd(), 'backfill-mint-prices-progress.json');
const DELAY_MS = 500; // 500ms between batches

interface Progress {
  lastProcessedId: number;
  totalProcessed: number;
  updated: number;
  skipped: number;
  noMatch: number;
  errors: Array<{ id: number; name: string; error: string }>;
  startTime: string;
  lastUpdateTime: string;
}

interface MintEvent {
  id: number;
  ens_name_id: number;
  transaction_hash: string | null;
  block_number: number | null;
  metadata: Record<string, unknown>;
  name: string;
}

interface Registration {
  id: number;
  total_cost_wei: string;
  transaction_hash: string;
  block_number: number;
}

function parseArgs(): { dryRun: boolean; batchSize: number; verbose: boolean; resume: boolean } {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const resume = args.includes('--resume');

  let batchSize = 100;
  const batchArg = args.find(arg => arg.startsWith('--batch-size='));
  if (batchArg) {
    const parsed = parseInt(batchArg.split('=')[1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      batchSize = parsed;
    }
  }

  return { dryRun, batchSize, verbose, resume };
}

async function loadProgress(): Promise<Progress | null> {
  try {
    const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveProgress(progress: Progress): Promise<void> {
  progress.lastUpdateTime = new Date().toISOString();
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function findMatchingRegistration(
  mintEvent: MintEvent
): Promise<Registration | null> {
  // Primary match: by ens_name_id + transaction_hash
  if (mintEvent.transaction_hash) {
    const txMatch = await pool.query<Registration>(
      `SELECT id, total_cost_wei, transaction_hash, block_number
       FROM registrations
       WHERE ens_name_id = $1 AND transaction_hash = $2
       LIMIT 1`,
      [mintEvent.ens_name_id, mintEvent.transaction_hash]
    );

    if (txMatch.rows.length > 0) {
      return txMatch.rows[0];
    }
  }

  // Fallback: by ens_name_id + closest block_number
  if (mintEvent.block_number) {
    const blockMatch = await pool.query<Registration>(
      `SELECT id, total_cost_wei, transaction_hash, block_number
       FROM registrations
       WHERE ens_name_id = $1
       ORDER BY ABS(block_number - $2)
       LIMIT 1`,
      [mintEvent.ens_name_id, mintEvent.block_number]
    );

    if (blockMatch.rows.length > 0) {
      return blockMatch.rows[0];
    }
  }

//   // Last resort: any registration for this ens_name_id
//   const anyMatch = await pool.query<Registration>(
//     `SELECT id, total_cost_wei, transaction_hash, block_number
//      FROM registrations
//      WHERE ens_name_id = $1
//      ORDER BY block_number DESC
//      LIMIT 1`,
//     [mintEvent.ens_name_id]
//   );

//   return anyMatch.rows.length > 0 ? anyMatch.rows[0] : null;

    return null;    
}

async function backfillMintPrices(): Promise<void> {
  const { dryRun, batchSize, verbose, resume } = parseArgs();

  console.log('=== Backfill Mint Prices from Registrations ===\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (database will be updated)'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Verbose: ${verbose}`);
  console.log('');

  // Load or create progress
  let progress = resume ? await loadProgress() : null;

  if (progress && resume) {
    console.log('Resuming from saved progress:');
    console.log(`  Last processed ID: ${progress.lastProcessedId}`);
    console.log(`  Updated: ${progress.updated}`);
    console.log(`  Skipped: ${progress.skipped}`);
    console.log(`  No match: ${progress.noMatch}`);
    console.log(`  Errors: ${progress.errors.length}`);
    console.log('');
  } else {
    progress = {
      lastProcessedId: 0,
      totalProcessed: 0,
      updated: 0,
      skipped: 0,
      noMatch: 0,
      errors: [],
      startTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
    };
    await saveProgress(progress);
    console.log('Starting fresh backfill process\n');
  }

  // Get total count of mint events needing update
  const countResult = await pool.query(
    `SELECT COUNT(*) as count
     FROM activity_history ah
     WHERE ah.event_type = 'mint'
       AND ah.price_wei IS NULL
       AND ah.id > $1`,
    [progress.lastProcessedId]
  );
  const totalRemaining = parseInt(countResult.rows[0].count, 10);
  console.log(`Mint events to process: ${totalRemaining}\n`);

  if (totalRemaining === 0) {
    console.log('No mint events need updating. Done!');
    return;
  }

  let hasMore = true;
  let batchNumber = 0;

  while (hasMore) {
    batchNumber++;

    // Fetch batch of mint events with NULL price_wei
    const mintEventsResult = await pool.query<MintEvent>(
      `SELECT
         ah.id,
         ah.ens_name_id,
         ah.transaction_hash,
         ah.block_number,
         ah.metadata,
         en.name
       FROM activity_history ah
       JOIN ens_names en ON en.id = ah.ens_name_id
       WHERE ah.event_type = 'mint'
         AND ah.price_wei IS NULL
         AND ah.id > $1
       ORDER BY ah.id
       LIMIT $2`,
      [progress.lastProcessedId, batchSize]
    );

    if (mintEventsResult.rows.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`Batch ${batchNumber}: Processing ${mintEventsResult.rows.length} mint events...`);

    for (const mintEvent of mintEventsResult.rows) {
      try {
        const registration = await findMatchingRegistration(mintEvent);

        if (!registration) {
          if (verbose) {
            console.log(`  [NO MATCH] Activity ${mintEvent.id} - ${mintEvent.name}`);
          }
          progress.noMatch++;
          progress.lastProcessedId = mintEvent.id;
          progress.totalProcessed++;
          continue;
        }

        // Build updated metadata with registration_id
        const updatedMetadata = {
          ...mintEvent.metadata,
          registration_id: registration.id,
        };

        if (dryRun) {
          if (verbose) {
            console.log(`  [DRY RUN] Would update activity ${mintEvent.id} - ${mintEvent.name}`);
            console.log(`    price_wei: ${registration.total_cost_wei}`);
            console.log(`    registration_id: ${registration.id}`);
          }
        } else {
          await pool.query(
            `UPDATE activity_history
             SET price_wei = $1,
                 metadata = $2
             WHERE id = $3`,
            [registration.total_cost_wei, JSON.stringify(updatedMetadata), mintEvent.id]
          );

          if (verbose) {
            const ethPrice = (parseFloat(registration.total_cost_wei) / 1e18).toFixed(6);
            console.log(`  [UPDATED] Activity ${mintEvent.id} - ${mintEvent.name} (${ethPrice} ETH)`);
          }
        }

        progress.updated++;
        progress.lastProcessedId = mintEvent.id;
        progress.totalProcessed++;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`  [ERROR] Activity ${mintEvent.id} - ${mintEvent.name}: ${errorMessage}`);
        progress.errors.push({
          id: mintEvent.id,
          name: mintEvent.name,
          error: errorMessage,
        });
        progress.skipped++;
        progress.lastProcessedId = mintEvent.id;
        progress.totalProcessed++;
      }
    }

    // Check if more records exist
    hasMore = mintEventsResult.rows.length === batchSize;

    // Save progress after each batch
    await saveProgress(progress);

    // Show batch summary
    const processed = progress.updated + progress.noMatch + progress.skipped;
    const remaining = totalRemaining - processed + (progress.lastProcessedId > 0 ? 0 : 0);
    console.log(`  Batch complete. Updated: ${progress.updated}, No match: ${progress.noMatch}, Errors: ${progress.errors.length}`);

    // Delay between batches
    if (hasMore) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  // Final summary
  console.log('\n=== Backfill Complete ===');
  console.log(`Total Processed: ${progress.totalProcessed}`);
  console.log(`Updated: ${progress.updated}`);
  console.log(`No Matching Registration: ${progress.noMatch}`);
  console.log(`Skipped (Errors): ${progress.skipped}`);
  console.log(`Duration: ${Math.floor((Date.now() - new Date(progress.startTime).getTime()) / 1000)}s`);

  if (progress.errors.length > 0) {
    console.log(`\nErrors encountered (${progress.errors.length}):`);
    progress.errors.slice(0, 10).forEach(err => {
      console.log(`  ${err.name} (ID: ${err.id}): ${err.error}`);
    });
    if (progress.errors.length > 10) {
      console.log(`  ... and ${progress.errors.length - 10} more errors`);
    }
    console.log(`\nSee ${PROGRESS_FILE} for complete error list`);
  }
}

// Run the script
backfillMintPrices()
  .then(async () => {
    console.log('\nScript completed successfully');
    await closeAllConnections();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('\nScript failed:', error);
    await closeAllConnections();
    process.exit(1);
  });
