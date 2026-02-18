#!/usr/bin/env tsx

/**
 * Import Creation Dates from ens-old-created repo
 *
 * This script:
 * 1. Loads created.json (labelhash hex → blockTimestamp mapping)
 * 2. Finds ENS names where creation_date is null
 * 3. Computes labelhash for each name and looks it up in the map
 * 4. Batch-updates creation_date in ens_names table using unnest
 *
 * Usage:
 *   npx tsx src/scripts/import-creation-dates.ts --file /path/to/created.json [--dry-run] [--limit 1000] [--batch-size 5000] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';
import { labelhash } from 'viem/ens';
import * as fs from 'fs';

async function importCreationDates(options: {
  file: string;
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun || false;
  const limit = options.limit || 10000000;
  const batchSize = options.batchSize || 5000;
  const offset = options.offset || 0;

  try {
    console.log('\n=== Importing Creation Dates from created.json ===\n');
    console.log(`File: ${options.file}`);
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Load created.json
    console.log('Loading created.json...');
    const raw = fs.readFileSync(options.file, 'utf-8');
    const createdData: Record<string, number> = JSON.parse(raw);
    const createdMap = new Map<string, number>();

    for (const [hash, timestamp] of Object.entries(createdData)) {
      // Normalize keys to lowercase with 0x prefix
      const key = hash.startsWith('0x') ? hash.toLowerCase() : ('0x' + hash).toLowerCase();
      createdMap.set(key, timestamp);
    }

    console.log(`Loaded ${createdMap.size} entries from created.json\n`);

    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalNotFound = 0;
    let totalFailed = 0;
    let currentOffset = offset;
    let batchNumber = 0;

    console.log('Starting import...\n');
    const startTime = Date.now();

    // Stream through DB in fetch batches, match in memory, write back in bulk
    while (true) {
      const fetchSize = Math.min(batchSize, limit - totalProcessed);
      if (fetchSize <= 0) break;

      const query = `
        SELECT id, name
        FROM ens_names
        WHERE creation_date IS NULL
          AND name NOT LIKE 'token-%'
          AND name NOT LIKE '#%'
          AND name LIKE '%.eth'
          AND name NOT LIKE '%.%.eth'
        ORDER BY id
        LIMIT $1 OFFSET $2
      `;

      const result = await pool.query(query, [fetchSize, currentOffset]);
      if (result.rows.length === 0) break;

      batchNumber++;
      const rows = result.rows;

      // Match against created.json in memory
      const matchedIds: number[] = [];
      const matchedDates: Date[] = [];
      let batchNotFound = 0;

      for (const row of rows) {
        const label = row.name.replace('.eth', '');
        if (!label) {
          batchNotFound++;
          continue;
        }

        let hash: string;
        try {
          hash = labelhash(label).toLowerCase();
        } catch {
          batchNotFound++;
          continue;
        }

        const blockTimestamp = createdMap.get(hash);
        if (blockTimestamp !== undefined) {
          matchedIds.push(row.id);
          matchedDates.push(new Date(blockTimestamp * 1000));
        } else {
          batchNotFound++;
        }
      }

      // Batch UPDATE using unnest — single query for the whole batch
      if (matchedIds.length > 0 && !dryRun) {
        try {
          await pool.query(
            `UPDATE ens_names AS en
             SET creation_date = v.creation_date
             FROM (SELECT unnest($1::int[]) AS id, unnest($2::timestamptz[]) AS creation_date) AS v
             WHERE en.id = v.id`,
            [matchedIds, matchedDates]
          );
        } catch (err: any) {
          console.error(`  ❌ Batch ${batchNumber} UPDATE failed: ${err.message}`);
          totalFailed += matchedIds.length;
          matchedIds.length = 0; // don't count as updated
        }
      }

      totalProcessed += rows.length;
      totalUpdated += matchedIds.length;
      totalNotFound += batchNotFound;
      currentOffset += rows.length;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (totalProcessed / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(`Batch ${batchNumber}: ${rows.length} rows, ${matchedIds.length} matched, ${batchNotFound} missed | Total: ${totalProcessed} processed, ${totalUpdated} updated (${elapsed}s, ${rate}/s)`);
    }

    // Summary
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n=== Import Summary ===\n');
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`Successfully updated: ${totalUpdated}`);
    console.log(`Not found in created.json: ${totalNotFound}`);
    console.log(`Failed to update: ${totalFailed}`);
    console.log(`Match rate: ${totalProcessed > 0 ? ((totalUpdated / totalProcessed) * 100).toFixed(2) : 0}%`);
    console.log(`Time: ${totalTime}s\n`);

    if (dryRun) {
      console.log('⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply updates\n');
    } else {
      console.log('✅ Database has been updated!\n');
    }

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: { file: string; dryRun?: boolean; limit?: number; batchSize?: number; offset?: number } = {
  file: '',
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    options.file = args[i + 1];
    i++;
  } else if (args[i] === '--dry-run') {
    options.dryRun = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    options.batchSize = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--offset' && args[i + 1]) {
    options.offset = parseInt(args[i + 1], 10);
    i++;
  }
}

if (!options.file) {
  console.error('Error: --file <path> is required');
  console.error('Usage: npx tsx src/scripts/import-creation-dates.ts --file /path/to/created.json [--dry-run] [--limit N] [--batch-size N] [--offset N]');
  process.exit(1);
}

if (!fs.existsSync(options.file)) {
  console.error(`Error: File not found: ${options.file}`);
  process.exit(1);
}

// Main execution
importCreationDates(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
