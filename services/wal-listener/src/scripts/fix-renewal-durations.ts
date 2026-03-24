/**
 * Repair script for renewal records with duration_seconds = 0.
 *
 * For each affected renewal, fetches the transaction from the blockchain and:
 *   1. Searches the receipt logs for a RenewalReferred event (has duration directly)
 *   2. Tries to decode the transaction calldata (renew/renewWithReferrer)
 *   3. Falls back to computing duration from the Controller NameRenewed event's
 *      `expires` value minus the previous known expiry from the DB
 *   4. Updates both the renewals table and activity_history metadata
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
  type Log,
} from 'viem';
import { mainnet } from 'viem/chains';
import PQueue from 'p-queue';
import { config, getPostgresPool } from '../../../shared/src';
import type { Pool } from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Event ABIs for receipt decoding
const RENEWAL_REFERRED_ABI = parseAbi([
  'event RenewalReferred(string label, bytes32 indexed labelHash, uint256 cost, uint256 duration, bytes32 referrer)',
]);

const CONTROLLER_RENEWAL_ORIGINAL_ABI = parseAbi([
  'event NameRenewed(string name, bytes32 indexed label, uint256 cost, uint256 expires)',
]);

const CONTROLLER_RENEWAL_V2_ABI = parseAbi([
  'event NameRenewed(string label, bytes32 indexed labelhash, uint256 cost, uint256 expires, bytes32 referrer)',
]);

// Function ABIs for calldata decoding
const CONTROLLER_FUNCTION_ABI = parseAbi([
  'function renew(string name, uint256 duration)',
  'function renewWithReferrer(string name, uint256 duration, bytes32 referrer)',
]);

const EVENT_EMITTER_ADDRESS = config.blockchain.ensBulkRenewalEventEmitter.toLowerCase();
const CONTROLLER_ADDRESSES = config.blockchain.ensControllerAddresses.map((a: string) => a.toLowerCase());

const client = createPublicClient({
  chain: mainnet,
  transport: http(config.blockchain.rpcUrl),
});

interface Stats {
  total: number;
  fixedFromReceipt: number;
  fixedFromCalldata: number;
  fixedFromExpiry: number;
  skipped: number;
  failed: number;
  activityUpdated: number;
}

interface ReceiptResult {
  // Duration from RenewalReferred event (most authoritative)
  renewalReferredDuration: number | null;
  // Map of name → expires timestamp from Controller NameRenewed events
  controllerExpires: Map<string, number>;
  // Diagnostics
  totalLogs: number;
  eventEmitterLogs: number;
  controllerLogs: number;
}

/**
 * Parse receipt logs for both RenewalReferred and Controller NameRenewed events.
 */
async function parseReceipt(txHash: string): Promise<ReceiptResult | null> {
  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    const result: ReceiptResult = {
      renewalReferredDuration: null,
      controllerExpires: new Map(),
      totalLogs: receipt.logs.length,
      eventEmitterLogs: 0,
      controllerLogs: 0,
    };

    for (const log of receipt.logs) {
      const logAddress = log.address.toLowerCase();

      // Check for RenewalReferred events from Event Emitter
      if (logAddress === EVENT_EMITTER_ADDRESS) {
        result.eventEmitterLogs++;
        try {
          const decoded = decodeEventLog({
            abi: RENEWAL_REFERRED_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'RenewalReferred') {
            const duration = Number((decoded.args as any).duration);
            if (duration > 0) {
              result.renewalReferredDuration = duration;
            }
          }
        } catch {
          // Not a RenewalReferred event
        }
      }

      // Check for Controller NameRenewed events
      if (CONTROLLER_ADDRESSES.includes(logAddress)) {
        result.controllerLogs++;
        // Try V2 first (more fields), then original
        for (const abi of [CONTROLLER_RENEWAL_V2_ABI, CONTROLLER_RENEWAL_ORIGINAL_ABI]) {
          try {
            const decoded = decodeEventLog({
              abi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === 'NameRenewed') {
              const args = decoded.args as any;
              const name = args.label || args.name;
              const expires = Number(args.expires);
              if (name && expires > 0) {
                result.controllerExpires.set(`${name}.eth`, expires);
              }
            }
            break; // Decoded successfully, don't try the other ABI
          } catch {
            // Try next ABI
          }
        }
      }
    }

    return result;
  } catch (err: any) {
    if (VERBOSE) console.log(`  Failed to fetch receipt for ${txHash}: ${err.message}`);
    return null;
  }
}

/**
 * Try to decode duration from transaction calldata.
 */
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

/**
 * Compute duration from the Controller event's `expires` value and the
 * previous known expiry from the DB (previous renewal or registration).
 * Both values are blockchain-derived so this is reliable.
 */
async function getDurationFromExpiry(
  pool: Pool,
  ensNameId: number,
  renewalId: number,
  newExpiresEpoch: number,
): Promise<number | null> {
  // Find the previous expiry: either the preceding renewal's new_expiry_date
  // or the registration's expiry_date if this is the first renewal
  const prevRenewal = await pool.query(
    `SELECT new_expiry_date FROM renewals
     WHERE ens_name_id = $1 AND id < $2
     ORDER BY id DESC LIMIT 1`,
    [ensNameId, renewalId]
  );

  let prevExpiryEpoch: number | null = null;

  if (prevRenewal.rows.length > 0 && prevRenewal.rows[0].new_expiry_date) {
    prevExpiryEpoch = Math.floor(new Date(prevRenewal.rows[0].new_expiry_date).getTime() / 1000);
  } else {
    // No previous renewal — try registration expiry
    const registration = await pool.query(
      `SELECT expiry_date FROM registrations
       WHERE ens_name_id = $1
       ORDER BY registration_date DESC LIMIT 1`,
      [ensNameId]
    );
    if (registration.rows.length > 0 && registration.rows[0].expiry_date) {
      prevExpiryEpoch = Math.floor(new Date(registration.rows[0].expiry_date).getTime() / 1000);
    }
  }

  if (prevExpiryEpoch == null) return null;

  const duration = newExpiresEpoch - prevExpiryEpoch;
  // Sanity check: duration should be positive and reasonable (1 day to 10 years)
  if (duration > 0 && duration <= 10 * 365 * 86400) {
    return duration;
  }

  if (VERBOSE) {
    console.log(`    Expiry computation out of range: ${duration}s (${Math.round(duration / 86400)}d)`);
  }
  return null;
}

async function main() {
  const pool = getPostgresPool();

  console.log('='.repeat(70));
  console.log('Fix Renewal Durations (duration_seconds = 0)');
  console.log('='.repeat(70));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Event Emitter: ${EVENT_EMITTER_ADDRESS}`);
  console.log(`Controllers: ${CONTROLLER_ADDRESSES.join(', ')}`);
  console.log();

  // Find all renewals with duration_seconds = 0
  const result = await pool.query(`
    SELECT r.id, r.transaction_hash, r.ens_name_id, en.name, r.new_expiry_date
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
    fixedFromExpiry: 0,
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
  let diagnosticSamples = 0;
  const skipReasons = { receiptFailed: 0, noControllerEvents: 0, noNameMatch: 0, noPrevExpiry: 0 };

  for (const [txHash, rows] of txHashToRows) {
    await queue.add(async () => {
      processed++;
      if (processed % 50 === 0) {
        console.log(`Processing ${processed}/${txHashToRows.size}...`);
      }

      // Strategy 1: Parse the receipt for RenewalReferred and Controller events
      const receiptResult = await parseReceipt(txHash);

      if (VERBOSE || (diagnosticSamples < 5 && !receiptResult?.renewalReferredDuration)) {
        if (receiptResult) {
          console.log(`  ${txHash.slice(0, 20)}... — ${receiptResult.totalLogs} logs, ${receiptResult.eventEmitterLogs} event_emitter, ${receiptResult.controllerLogs} controller, ${receiptResult.controllerExpires.size} expires found`);
        } else {
          console.log(`  ${txHash.slice(0, 20)}... — receipt fetch failed`);
        }
        diagnosticSamples++;
      }

      // If we got a RenewalReferred duration, use it for all rows in this tx
      if (receiptResult?.renewalReferredDuration) {
        const duration = receiptResult.renewalReferredDuration;
        for (const row of rows) {
          await applyFix(pool, row, duration, 'receipt', stats);
          stats.fixedFromReceipt++;
        }
        return;
      }

      // Strategy 2: Try to decode from transaction calldata
      const calldataDuration = await getDurationFromCalldata(txHash);
      if (calldataDuration != null) {
        for (const row of rows) {
          await applyFix(pool, row, calldataDuration, 'calldata', stats);
          stats.fixedFromCalldata++;
        }
        return;
      }

      // Strategy 3: Use Controller event's `expires` + previous expiry from DB
      if (receiptResult && receiptResult.controllerExpires.size > 0) {
        for (const row of rows) {
          const expiresEpoch = receiptResult.controllerExpires.get(row.name);
          if (!expiresEpoch) {
            stats.skipped++;
            skipReasons.noNameMatch++;
            if (VERBOSE) console.log(`  SKIP ${row.name} — name not found in controller events (found: ${[...receiptResult.controllerExpires.keys()].join(', ')})`);
            continue;
          }
          const duration = await getDurationFromExpiry(pool, row.ens_name_id, row.id, expiresEpoch);
          if (duration != null) {
            await applyFix(pool, row, duration, 'expiry', stats);
            stats.fixedFromExpiry++;
          } else {
            stats.skipped++;
            skipReasons.noPrevExpiry++;
            if (VERBOSE) console.log(`  SKIP ${row.name} — no previous expiry found in DB`);
          }
        }
        return;
      }

      // All strategies failed — no controller events in receipt
      if (!receiptResult) {
        skipReasons.receiptFailed += rows.length;
      } else {
        skipReasons.noControllerEvents += rows.length;
      }
      stats.skipped += rows.length;
      if (VERBOSE) console.log(`  SKIP ${txHash.slice(0, 20)}... — ${!receiptResult ? 'receipt fetch failed' : 'no controller events in receipt'}`);
    });
  }

  await queue.onIdle();

  // Backfill activity_history records that are missing duration_seconds entirely
  // but have a valid value in the renewals table
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
  console.log(`  Fixed (from expiry):    ${stats.fixedFromExpiry}`);
  console.log(`  Skipped (undecoded):    ${stats.skipped}`);
  if (stats.skipped > 0) {
    console.log(`    - receipt fetch failed:    ${skipReasons.receiptFailed}`);
    console.log(`    - no controller events:    ${skipReasons.noControllerEvents}`);
    console.log(`    - name mismatch:           ${skipReasons.noNameMatch}`);
    console.log(`    - no previous expiry:      ${skipReasons.noPrevExpiry}`);
  }
  console.log(`  Failed:                 ${stats.failed}`);
  console.log(`  Activity records fixed: ${stats.activityUpdated}`);
  console.log('='.repeat(70));

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes were made. Run without --dry-run to apply fixes.');
  }

  await pool.end();
}

async function applyFix(
  pool: Pool,
  row: { id: number; name: string; ens_name_id: number; transaction_hash: string },
  duration: number,
  source: string,
  stats: Stats,
) {
  if (VERBOSE) {
    console.log(`  FIX ${row.name} (${row.transaction_hash.slice(0, 20)}...) → ${duration}s (${Math.round(duration / 86400)}d) via ${source}`);
  }

  if (!DRY_RUN) {
    try {
      await pool.query(
        'UPDATE renewals SET duration_seconds = $1 WHERE id = $2',
        [duration, row.id]
      );

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
        [duration, row.ens_name_id, row.transaction_hash]
      );

      if (actResult.rowCount && actResult.rowCount > 0) {
        stats.activityUpdated += actResult.rowCount;
      }
    } catch (err: any) {
      stats.failed++;
      console.error(`  ERROR updating ${row.name}: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
