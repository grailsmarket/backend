#!/usr/bin/env tsx
/**
 * Slowly fix has_emoji field in PostgreSQL
 *
 * This script updates PostgreSQL in small batches with delays between them,
 * allowing the WAL listener to process changes without being overwhelmed.
 *
 * Run this AFTER fix-emoji-detection.ts (which fixes Elasticsearch immediately).
 * This script can run in the background over hours/days to gradually fix PostgreSQL.
 *
 * Usage:
 *   npx tsx src/scripts/fix-emoji-postgres-slow.ts [--dry-run] [--batch-size=20] [--delay=2000]
 *
 * Options:
 *   --dry-run       Preview without making changes
 *   --batch-size=N  Records per batch (default: 20)
 *   --delay=N       Milliseconds between batches (default: 2000)
 */

import { getPostgresPool, closeAllConnections, hasEmoji } from '../../../shared/src';

const pool = getPostgresPool();

// Parse command line args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '20', 10);
const DELAY_MS = parseInt(args.find(a => a.startsWith('--delay='))?.split('=')[1] || '2000', 10);

interface NameToFix {
  id: number;
  name: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('Slow PostgreSQL Emoji Fix Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Delay between batches: ${DELAY_MS}ms`);
  console.log('='.repeat(60));
  console.log();

  // Find all names where has_emoji is false but actually contain emojis
  console.log('Scanning for names with incorrect has_emoji=false...');
  const result = await pool.query<NameToFix>(
    `SELECT id, name FROM ens_names WHERE has_emoji = false AND name NOT LIKE 'token-%'`
  );

  console.log(`Checked ${result.rows.length} names with has_emoji=false`);

  const namesToFix: NameToFix[] = [];
  for (const row of result.rows) {
    if (hasEmoji(row.name)) {
      namesToFix.push(row);
    }
  }

  console.log(`Found ${namesToFix.length} names that need fixing`);
  console.log();

  if (namesToFix.length === 0) {
    console.log('No names need fixing. Exiting.');
    await closeAllConnections();
    return;
  }

  // Estimate time
  const totalBatches = Math.ceil(namesToFix.length / BATCH_SIZE);
  const estimatedMinutes = Math.ceil((totalBatches * DELAY_MS) / 60000);
  console.log(`Estimated time: ~${estimatedMinutes} minutes (${totalBatches} batches)`);
  console.log();

  if (DRY_RUN) {
    console.log('Examples of names to fix:');
    for (const row of namesToFix.slice(0, 10)) {
      console.log(`  - ${row.name}`);
    }
    console.log();
    console.log(`Would update ${namesToFix.length} names (dry run).`);
    await closeAllConnections();
    return;
  }

  // Process in batches with delays
  let updated = 0;
  const startTime = Date.now();

  for (let i = 0; i < namesToFix.length; i += BATCH_SIZE) {
    const batch = namesToFix.slice(i, i + BATCH_SIZE);
    const ids = batch.map(r => r.id);

    await pool.query(
      `UPDATE ens_names SET has_emoji = true WHERE id = ANY($1)`,
      [ids]
    );

    updated += batch.length;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rate = updated / elapsed || 0;
    const remaining = Math.round((namesToFix.length - updated) / rate) || 0;

    console.log(`Updated ${updated}/${namesToFix.length} (${Math.round(updated/namesToFix.length*100)}%) - ETA: ${remaining}s`);

    // Delay before next batch (unless this is the last batch)
    if (i + BATCH_SIZE < namesToFix.length) {
      await sleep(DELAY_MS);
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log();
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Names fixed: ${updated}`);
  console.log(`Total time: ${totalTime}s`);

  await closeAllConnections();
}

main().catch(async err => {
  console.error('Script failed:', err);
  await closeAllConnections();
  process.exit(1);
});
