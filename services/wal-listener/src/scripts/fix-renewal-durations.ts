/**
 * Repair script for renewal records with duration_seconds = 0.
 *
 * For each affected renewal, fetches the transaction from the blockchain and:
 *   1. Searches the receipt logs for a RenewalReferred event (has duration directly)
 *   2. If not found, tries to decode the transaction calldata (renew/renewWithReferrer)
 *   3. Updates both the renewals table and activity_history metadata
 *
 * Usage:
 *   npm run build && node dist/wal-listener/src/scripts/fix-renewal-durations.js
 *   npm run build && node dist/wal-listener/src/scripts/fix-renewal-durations.js --dry-run
 *   npm run build && node dist/wal-listener/src/scripts/fix-renewal-durations.js --verbose
 */

import {
  createPublicClient,
  http,
  decodeEventLog,
  decodeFunctionData,
  parseAbi,
} from 'viem';
import { mainnet } from 'viem/chains';
import PQueue from 'p-queue';
import { config, getPostgresPool } from '../../../shared/src';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const RENEWAL_REFERRED_ABI = parseAbi([
  'event RenewalReferred(string label, bytes32 indexed labelHash, uint256 cost, uint256 duration, bytes32 referrer)',
]);

const CONTROLLER_FUNCTION_ABI = parseAbi([
  'function renew(string name, uint256 duration)',
  'function renewWithReferrer(string name, uint256 duration, bytes32 referrer)',
]);

const client = createPublicClient({
  chain: mainnet,
  transport: http(config.blockchain.rpcUrl),
});

interface Stats {
  total: number;
  fixedFromReceipt: number;
  fixedFromCalldata: number;
  skipped: number;
  failed: number;
  activityUpdated: number;
}

async function getDurationFromReceipt(txHash: string): Promise<number | null> {
  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: RENEWAL_REFERRED_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'RenewalReferred') {
          const duration = Number((decoded.args as any).duration);
          if (duration > 0) return duration;
        }
      } catch {
        // Not a RenewalReferred event, continue
      }
    }
  } catch (err: any) {
    if (VERBOSE) console.log(`  Failed to fetch receipt for ${txHash}: ${err.message}`);
  }
  return null;
}

async function getDurationFromCalldata(txHash: string): Promise<number | null> {
  try {
    const tx = await client.getTransaction({
      hash: txHash as `0x${string}`,
    });

    if (!tx || !tx.input) return null;

    try {
      const decoded = decodeFunctionData({
        abi: CONTROLLER_FUNCTION_ABI,
        data: tx.input,
      });
      const duration = Number(decoded.args[1]);
      return duration > 0 ? duration : null;
    } catch {
      // Not a direct Controller call (probably a wrapper contract)
      return null;
    }
  } catch (err: any) {
    if (VERBOSE) console.log(`  Failed to fetch tx for ${txHash}: ${err.message}`);
  }
  return null;
}

async function main() {
  const pool = getPostgresPool();

  console.log('='.repeat(70));
  console.log('Fix Renewal Durations (duration_seconds = 0)');
  console.log('='.repeat(70));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log();

  // Find all renewals with duration_seconds = 0
  const result = await pool.query(`
    SELECT r.id, r.transaction_hash, r.ens_name_id, en.name
    FROM renewals r
    JOIN ens_names en ON en.id = r.ens_name_id
    WHERE r.duration_seconds = 0
    ORDER BY r.id
  `);

  console.log(`Found ${result.rows.length} renewals with duration_seconds = 0`);
  console.log();

  if (result.rows.length === 0) {
    console.log('Nothing to fix!');
    await pool.end();
    return;
  }

  const stats: Stats = {
    total: result.rows.length,
    fixedFromReceipt: 0,
    fixedFromCalldata: 0,
    skipped: 0,
    failed: 0,
    activityUpdated: 0,
  };

  // Dedupe by transaction_hash (multiple renewals in same tx share receipt)
  const txHashToRows = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const existing = txHashToRows.get(row.transaction_hash) || [];
    existing.push(row);
    txHashToRows.set(row.transaction_hash, existing);
  }

  console.log(`Unique transactions to fetch: ${txHashToRows.size}`);
  console.log();

  // Rate-limited queue for RPC calls
  const queue = new PQueue({ concurrency: 5, interval: 1000, intervalCap: 10 });
  let processed = 0;

  for (const [txHash, rows] of txHashToRows) {
    await queue.add(async () => {
      processed++;
      if (processed % 50 === 0 || VERBOSE) {
        console.log(`Processing ${processed}/${txHashToRows.size}...`);
      }

      // Strategy 1: Try to get duration from RenewalReferred event in receipt
      let duration = await getDurationFromReceipt(txHash);
      let source = 'receipt';

      // Strategy 2: Try to decode from transaction calldata
      if (duration == null) {
        duration = await getDurationFromCalldata(txHash);
        source = 'calldata';
      }

      if (duration == null) {
        stats.skipped += rows.length;
        if (VERBOSE) console.log(`  SKIP ${txHash.slice(0, 20)}... — could not decode duration`);
        return;
      }

      for (const row of rows) {
        if (VERBOSE) {
          console.log(`  FIX ${row.name} (${txHash.slice(0, 20)}...) → ${duration}s (${Math.round(duration / 86400)}d) via ${source}`);
        }

        if (!DRY_RUN) {
          try {
            // Update renewals table
            await pool.query(
              'UPDATE renewals SET duration_seconds = $1 WHERE id = $2',
              [duration, row.id]
            );

            // Update activity_history metadata
            const actResult = await pool.query(
              `UPDATE activity_history
               SET metadata = metadata || jsonb_build_object('duration_seconds', $1::bigint)
               WHERE ens_name_id = $2
                 AND event_type = 'renewal'
                 AND transaction_hash = $3::varchar
                 AND (
                   metadata->>'duration_seconds' IS NULL
                   OR (metadata->>'duration_seconds')::bigint <= 0
                 )`,
              [duration, row.ens_name_id, txHash]
            );

            if (actResult.rowCount && actResult.rowCount > 0) {
              stats.activityUpdated += actResult.rowCount;
            }
          } catch (err: any) {
            stats.failed++;
            console.error(`  ERROR updating ${row.name}: ${err.message}`);
            return;
          }
        }

        if (source === 'receipt') {
          stats.fixedFromReceipt++;
        } else {
          stats.fixedFromCalldata++;
        }
      }
    });
  }

  await queue.onIdle();

  // Backfill activity_history records that are missing duration_seconds entirely
  // but have a valid value in the renewals table (from prior backfill runs that
  // didn't include duration, or records fixed above)
  console.log('\nBackfilling missing duration_seconds into activity_history...');
  if (!DRY_RUN) {
    const backfillResult = await pool.query(`
      UPDATE activity_history ah
      SET metadata = ah.metadata || jsonb_build_object('duration_seconds', rn.duration_seconds)
      FROM renewals rn
      WHERE ah.event_type = 'renewal'
        AND ah.transaction_hash = rn.transaction_hash
        AND ah.ens_name_id = rn.ens_name_id
        AND rn.duration_seconds IS NOT NULL AND rn.duration_seconds > 0
        AND (ah.metadata->>'duration_seconds') IS NULL
    `);
    stats.activityUpdated += backfillResult.rowCount || 0;
    console.log(`  Backfilled ${backfillResult.rowCount || 0} activity_history records`);
  } else {
    const countResult = await pool.query(`
      SELECT COUNT(*) as cnt
      FROM activity_history ah
      JOIN renewals rn ON ah.transaction_hash = rn.transaction_hash AND ah.ens_name_id = rn.ens_name_id
      WHERE ah.event_type = 'renewal'
        AND rn.duration_seconds IS NOT NULL AND rn.duration_seconds > 0
        AND (ah.metadata->>'duration_seconds') IS NULL
    `);
    console.log(`  Would backfill ${countResult.rows[0].cnt} activity_history records`);
  }

  // Report any remaining 0s for manual investigation
  const remainingResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM renewals WHERE duration_seconds = 0
  `);
  const remainingActivity = await pool.query(`
    SELECT COUNT(*) as cnt FROM activity_history
    WHERE event_type = 'renewal' AND (metadata->>'duration_seconds')::bigint = 0
  `);
  if (parseInt(remainingResult.rows[0].cnt) > 0 || parseInt(remainingActivity.rows[0].cnt) > 0) {
    console.log(`\nRemaining records with duration_seconds = 0:`);
    console.log(`  renewals:         ${remainingResult.rows[0].cnt}`);
    console.log(`  activity_history: ${remainingActivity.rows[0].cnt}`);
  }

  console.log();
  console.log('='.repeat(70));
  console.log('Results:');
  console.log(`  Total records:          ${stats.total}`);
  console.log(`  Fixed (from receipt):   ${stats.fixedFromReceipt}`);
  console.log(`  Fixed (from calldata):  ${stats.fixedFromCalldata}`);
  console.log(`  Skipped (undecoded):    ${stats.skipped}`);
  console.log(`  Failed:                 ${stats.failed}`);
  console.log(`  Activity records fixed: ${stats.activityUpdated}`);
  console.log('='.repeat(70));

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes were made. Run without --dry-run to apply fixes.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
