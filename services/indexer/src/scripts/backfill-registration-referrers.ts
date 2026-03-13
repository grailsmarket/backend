#!/usr/bin/env node
/**
 * Backfill registration referrers from on-chain transaction receipts
 *
 * Processes existing registrations where referrer IS NULL, fetches their
 * on-chain receipts, and parses Controller V2 NameRegistered events
 * to extract the referrer field.
 *
 * Note: Most older registrations went through the original controller
 * and won't have a referrer. This script gracefully skips those.
 *
 * Usage:
 *   npm run build && node dist/services/indexer/src/scripts/backfill-registration-referrers.js [options]
 *
 * Options:
 *   --batch-size N   Number of registrations to process per batch (default: 50)
 *   --limit N        Maximum number of registrations to process
 *   --dry-run        Only log what would be updated, don't write to DB
 */

import { Pool } from 'pg';
import { createPublicClient, http, decodeEventLog, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

// V2 Controller NameRegistered event (has referrer param)
const CONTROLLER_V2_ABI = parseAbi([
  'event NameRegistered(string label, bytes32 indexed labelhash, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires, bytes32 referrer)',
]);

const V2_CONTROLLER_ADDRESS = '0x59e16fccd424cc24e280be16e11bcd56fb0ce547';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

interface Stats {
  processed: number;
  updated: number;
  noReferrer: number;
  failed: number;
}

async function backfill(client: ReturnType<typeof createPublicClient>, batchSize: number, limit: number | undefined, dryRun: boolean) {
  const stats: Stats = { processed: 0, updated: 0, noReferrer: 0, failed: 0 };
  let lastId: number | null = null;
  let batchNum = 0;

  console.log(`Starting registration referrer backfill (batch size: ${batchSize}, dry-run: ${dryRun})...`);

  while (true) {
    if (limit && stats.processed >= limit) break;

    batchNum++;
    const currentBatchSize = limit ? Math.min(batchSize, limit - stats.processed) : batchSize;

    // Fetch batch of registrations without referrer
    const batchResult: any = lastId === null
      ? await pool.query(
          `SELECT r.id, r.transaction_hash, r.ens_name_id, en.name
           FROM registrations r
           JOIN ens_names en ON r.ens_name_id = en.id
           WHERE r.referrer IS NULL
           ORDER BY r.id ASC
           LIMIT $1`,
          [currentBatchSize]
        )
      : await pool.query(
          `SELECT r.id, r.transaction_hash, r.ens_name_id, en.name
           FROM registrations r
           JOIN ens_names en ON r.ens_name_id = en.id
           WHERE r.referrer IS NULL AND r.id > $1
           ORDER BY r.id ASC
           LIMIT $2`,
          [lastId, currentBatchSize]
        );

    const batch: any[] = batchResult.rows;
    if (batch.length === 0) break;

    lastId = batch[batch.length - 1].id;

    for (const row of batch) {
      stats.processed++;

      try {
        // Fetch transaction receipt
        const receipt = await client.getTransactionReceipt({ hash: row.transaction_hash as `0x${string}` });

        // Look for V2 Controller NameRegistered event in receipt logs
        let referrer: string | null = null;

        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== V2_CONTROLLER_ADDRESS) continue;

          try {
            const decoded = decodeEventLog({
              abi: CONTROLLER_V2_ABI,
              data: log.data,
              topics: log.topics as any,
            });

            if (decoded.args.referrer) {
              referrer = decoded.args.referrer;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!referrer) {
          stats.noReferrer++;
          continue;
        }

        if (dryRun) {
          console.log(`  [DRY-RUN] Would update ${row.name}: referrer=${referrer}`);
          stats.updated++;
          continue;
        }

        await pool.query(
          `UPDATE registrations SET referrer = $1
           WHERE transaction_hash = $2 AND ens_name_id = $3`,
          [referrer, row.transaction_hash, row.ens_name_id]
        );
        stats.updated++;
      } catch (error: any) {
        console.error(`  Error processing registration ${row.id} (${row.name}): ${error.message}`);
        stats.failed++;
      }
    }

    console.log(`Batch ${batchNum}: ${stats.processed} processed | ${stats.updated} updated | ${stats.noReferrer} no referrer | ${stats.failed} failed`);

    // Rate limit delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\nDone!');
  console.log(`Processed: ${stats.processed}, Updated: ${stats.updated}, No referrer: ${stats.noReferrer}, Failed: ${stats.failed}`);
}

async function main() {
  console.log('Backfill registration referrers script starting...');

  const args = process.argv.slice(2);
  let batchSize = 50;
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  console.log(`Batch size: ${batchSize}, Limit: ${limit || 'unlimited'}, Dry-run: ${dryRun}`);

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable not set!');
    process.exit(1);
  }

  if (!process.env.RPC_URL) {
    console.error('ERROR: RPC_URL environment variable not set!');
    process.exit(1);
  }

  const viemClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL),
  });

  try {
    console.log('Connecting to database...');
    await pool.query('SELECT 1');
    console.log('Database connected!');

    const countResult = await pool.query(`SELECT COUNT(*) FROM registrations WHERE referrer IS NULL`);
    console.log(`Registrations without referrer: ${countResult.rows[0].count}`);

    await backfill(viemClient, batchSize, limit, dryRun);

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
