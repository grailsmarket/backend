#!/usr/bin/env tsx

/**
 * Backfill Renewals Table
 *
 * Processes existing renewal transactions from the `transactions` table,
 * fetches their on-chain receipts, and parses Controller NameRenewed
 * and RenewalReferred events to populate the `renewals` table.
 *
 * A bulk renewal tx may have multiple names but only one record in `transactions`.
 * The receipt parsing finds ALL NameRenewed events in the tx and creates a
 * renewal record for each.
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node dist/wal-listener/src/scripts/backfill-renewals.js [options]
 *
 * Options:
 *   --dry-run              Preview without inserting
 *   --batch-size <n>       Transactions per batch (default: 50)
 *   --limit <n>            Maximum transactions to process
 *   --verbose              Show detailed logs
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';
import { createPublicClient, http, decodeEventLog, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

// Controller NameRenewed ABIs
const CONTROLLER_RENEWAL_ORIGINAL = parseAbi([
  'event NameRenewed(string name, bytes32 indexed label, uint256 cost, uint256 expires)',
]);
const CONTROLLER_RENEWAL_V2 = parseAbi([
  'event NameRenewed(string label, bytes32 indexed labelhash, uint256 cost, uint256 expires, bytes32 referrer)',
]);

// RenewalReferred event ABI (Event Emitter contract)
const RENEWAL_REFERRED = parseAbi([
  'event RenewalReferred(string label, bytes32 indexed labelHash, uint256 cost, uint256 duration, bytes32 referrer)',
]);

const EVENT_EMITTER_ADDRESS = config.blockchain.ensBulkRenewalEventEmitter.toLowerCase();
const CONTROLLER_ADDRESSES = config.blockchain.ensControllerAddresses.map(a => a.toLowerCase());

interface Options {
  dryRun: boolean;
  batchSize: number;
  limit: number | undefined;
  verbose: boolean;
}

interface Stats {
  txProcessed: number;
  renewalsInserted: number;
  skipped: number;
  failed: number;
  alreadyExists: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillRenewals(options: Options) {
  const pool = getPostgresPool();
  const startTime = Date.now();

  const stats: Stats = { txProcessed: 0, renewalsInserted: 0, skipped: 0, failed: 0, alreadyExists: 0 };

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  try {
    console.log('\n================================================================================');
    console.log('Backfill Renewals Script');
    console.log('================================================================================\n');
    console.log(`Mode:          ${options.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log(`Batch size:    ${options.batchSize} transactions`);
    console.log(`Limit:         ${options.limit || 'unlimited'}`);
    console.log(`Verbose:       ${options.verbose ? 'YES' : 'NO'}`);
    console.log(`Controllers:   ${CONTROLLER_ADDRESSES.join(', ')}`);
    console.log(`Event Emitter: ${EVENT_EMITTER_ADDRESS}`);
    console.log('');

    const countResult = await pool.query(`SELECT COUNT(*) FROM transactions WHERE transaction_type = 'renewal'`);
    console.log(`Total renewal transactions: ${countResult.rows[0].count}\n`);

    let lastId: number | null = null;
    let batchNum = 0;

    while (true) {
      if (options.limit && stats.txProcessed >= options.limit) break;

      batchNum++;
      const currentBatchSize = options.limit
        ? Math.min(options.batchSize, options.limit - stats.txProcessed)
        : options.batchSize;

      // Fetch batch of renewal transactions
      const batchResult: any = lastId === null
        ? await pool.query(
            `SELECT t.id, t.transaction_hash, t.ens_name_id, t.block_number, t.timestamp,
                    en.name
             FROM transactions t
             JOIN ens_names en ON t.ens_name_id = en.id
             WHERE t.transaction_type = 'renewal'
             ORDER BY t.id ASC
             LIMIT $1`,
            [currentBatchSize]
          )
        : await pool.query(
            `SELECT t.id, t.transaction_hash, t.ens_name_id, t.block_number, t.timestamp,
                    en.name
             FROM transactions t
             JOIN ens_names en ON t.ens_name_id = en.id
             WHERE t.transaction_type = 'renewal' AND t.id > $1
             ORDER BY t.id ASC
             LIMIT $2`,
            [lastId, currentBatchSize]
          );

      const batch: any[] = batchResult.rows;
      if (batch.length === 0) break;

      lastId = batch[batch.length - 1].id;

      // Group by transaction_hash since a bulk renewal tx may contain multiple names
      const txHashGroups = new Map<string, typeof batch>();
      for (const row of batch) {
        const existing = txHashGroups.get(row.transaction_hash) || [];
        existing.push(row);
        txHashGroups.set(row.transaction_hash, existing);
      }

      for (const [txHash, rows] of txHashGroups) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
          const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
          const renewerAddress = tx.from.toLowerCase();

          for (const log of receipt.logs) {
            const logAddress = log.address.toLowerCase();

            // Try Controller NameRenewed events
            if (CONTROLLER_ADDRESSES.includes(logAddress)) {
              let decoded: any = null;
              let isV2 = false;

              try {
                decoded = decodeEventLog({
                  abi: CONTROLLER_RENEWAL_ORIGINAL,
                  data: log.data,
                  topics: log.topics as any,
                });
              } catch {
                try {
                  decoded = decodeEventLog({
                    abi: CONTROLLER_RENEWAL_V2,
                    data: log.data,
                    topics: log.topics as any,
                  });
                  isV2 = true;
                } catch {
                  continue;
                }
              }

              if (!decoded) continue;

              const name = isV2 ? decoded.args.label : decoded.args.name;
              const fullName = `${name}.eth`;
              const costWei = decoded.args.cost.toString();
              const expiryDate = new Date(Number(decoded.args.expires) * 1000);
              const referrer = isV2 && decoded.args.referrer ? decoded.args.referrer : null;
              const nameLength = name.length;

              const ensNameResult = await pool.query('SELECT id FROM ens_names WHERE name = $1', [fullName]);
              if (ensNameResult.rows.length === 0) {
                if (options.verbose) {
                  console.log(`  Name ${fullName} not found in ens_names, skipping`);
                }
                stats.skipped++;
                continue;
              }

              const ensNameId = ensNameResult.rows[0].id;
              const renewalDate = rows[0]?.timestamp || new Date();

              if (options.dryRun) {
                if (options.verbose) {
                  console.log(`  [DRY-RUN] Would insert renewal: ${fullName}, cost=${costWei}, referrer=${referrer || 'none'}`);
                }
                stats.renewalsInserted++;
                continue;
              }

              try {
                const insertResult = await pool.query(
                  `INSERT INTO renewals (
                    ens_name_id, renewer_address, cost_wei,
                    new_expiry_date, referrer, name_length,
                    transaction_hash, block_number, renewal_date, metadata
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                  ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
                  RETURNING id`,
                  [
                    ensNameId, renewerAddress, costWei,
                    expiryDate, referrer, nameLength,
                    txHash, log.blockNumber?.toString(),
                    renewalDate,
                    JSON.stringify({ source: 'backfill_controller', version: isV2 ? 'v2' : 'original' }),
                  ]
                );

                if (insertResult.rows.length > 0) {
                  stats.renewalsInserted++;
                  if (options.verbose) {
                    console.log(`  Inserted renewal for ${fullName} (id: ${insertResult.rows[0].id})`);
                  }
                } else {
                  stats.alreadyExists++;
                }
              } catch (insertErr: any) {
                if (insertErr.code === '23505') {
                  stats.alreadyExists++;
                } else {
                  throw insertErr;
                }
              }
            }

            // Try RenewalReferred events from Event Emitter
            if (logAddress === EVENT_EMITTER_ADDRESS) {
              let decoded: any = null;

              try {
                decoded = decodeEventLog({
                  abi: RENEWAL_REFERRED,
                  data: log.data,
                  topics: log.topics as any,
                });
              } catch {
                continue;
              }

              if (!decoded) continue;

              const { label, cost, duration, referrer } = decoded.args;
              const fullName = `${label}.eth`;
              const costWei = cost.toString();
              const durationSeconds = Number(duration);
              const nameLength = label.length;

              const ensNameResult = await pool.query('SELECT id, expiry_date FROM ens_names WHERE name = $1', [fullName]);
              if (ensNameResult.rows.length === 0) {
                if (options.verbose) {
                  console.log(`  Name ${fullName} not found in ens_names, skipping RenewalReferred`);
                }
                stats.skipped++;
                continue;
              }

              const ensNameId = ensNameResult.rows[0].id;
              const newExpiryDate = ensNameResult.rows[0].expiry_date || rows[0]?.timestamp || new Date();
              const renewalDate = rows[0]?.timestamp || new Date();

              if (options.dryRun) {
                if (options.verbose) {
                  console.log(`  [DRY-RUN] Would insert RenewalReferred: ${fullName}, cost=${costWei}, referrer=${referrer}`);
                }
                stats.renewalsInserted++;
                continue;
              }

              try {
                const insertResult = await pool.query(
                  `INSERT INTO renewals (
                    ens_name_id, renewer_address, cost_wei, duration_seconds,
                    new_expiry_date, referrer, name_length,
                    transaction_hash, block_number, renewal_date, metadata
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                  ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
                  RETURNING id`,
                  [
                    ensNameId, renewerAddress, costWei, durationSeconds,
                    newExpiryDate, referrer, nameLength,
                    txHash, log.blockNumber?.toString(),
                    renewalDate,
                    JSON.stringify({ source: 'backfill_event_emitter' }),
                  ]
                );

                if (insertResult.rows.length > 0) {
                  stats.renewalsInserted++;
                  if (options.verbose) {
                    console.log(`  Inserted RenewalReferred for ${fullName} (id: ${insertResult.rows[0].id})`);
                  }
                } else {
                  stats.alreadyExists++;
                }
              } catch (insertErr: any) {
                if (insertErr.code === '23505') {
                  stats.alreadyExists++;
                } else {
                  throw insertErr;
                }
              }
            }
          }
        } catch (error: any) {
          console.error(`  Error processing tx ${txHash}: ${error.message}`);
          stats.failed++;
        }

        stats.txProcessed += rows.length;
      }

      console.log(
        `Batch ${batchNum}: ${stats.txProcessed} txs | ` +
        `${stats.renewalsInserted} inserted | ` +
        `${stats.alreadyExists} exist | ` +
        `${stats.skipped} skipped | ` +
        `${stats.failed} failed`
      );

      await sleep(500);
    }

    const duration = Date.now() - startTime;
    console.log('\n================================================================================');
    console.log('Backfill Renewals Summary');
    console.log('================================================================================');
    console.log(`Transactions processed: ${stats.txProcessed}`);
    console.log(`Renewals inserted:     ${stats.renewalsInserted}`);
    console.log(`Already exist:         ${stats.alreadyExists}`);
    console.log(`Skipped:               ${stats.skipped}`);
    console.log(`Failed:                ${stats.failed}`);
    console.log(`Duration:              ${Math.floor(duration / 1000)}s`);
    if (options.dryRun) {
      console.log('\nDRY RUN - No changes made');
    }
    console.log('================================================================================\n');

  } catch (error: any) {
    console.error('\nFatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await closeAllConnections();
  }
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    dryRun: false,
    batchSize: 50,
    limit: undefined,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--limit' && args[i + 1]) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return options;
}

const opts = parseArgs();
backfillRenewals(opts).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
