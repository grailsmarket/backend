#!/usr/bin/env node
/**
 * Backfill renewals table from transaction receipts
 *
 * Processes existing renewal transactions from the `transactions` table,
 * fetches their on-chain receipts, and parses Controller NameRenewed
 * and RenewalReferred events to populate the `renewals` table.
 *
 * Usage:
 *   npm run build && node dist/services/indexer/src/scripts/backfill-renewals.js [options]
 *
 * Options:
 *   --batch-size N   Number of transactions to process per batch (default: 50)
 *   --limit N        Maximum number of transactions to process
 *   --dry-run        Only log what would be inserted, don't write to DB
 */

import { Pool } from 'pg';
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

const EVENT_EMITTER_ADDRESS = '0xf55575bde5953ee4272d5ce7cdd924c74d8fa81a';
const CONTROLLER_ADDRESSES = [
  '0x253553366da8546fc250f225fe3d25d0c782303b',
  '0x59e16fccd424cc24e280be16e11bcd56fb0ce547',
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

interface Stats {
  txProcessed: number;
  renewalsInserted: number;
  skipped: number;
  failed: number;
  alreadyExists: number;
}

async function backfill(client: ReturnType<typeof createPublicClient>, batchSize: number, limit: number | undefined, dryRun: boolean) {
  const stats: Stats = { txProcessed: 0, renewalsInserted: 0, skipped: 0, failed: 0, alreadyExists: 0 };
  let lastId: number | null = null;
  let batchNum = 0;

  console.log(`Starting renewal backfill (batch size: ${batchSize}, dry-run: ${dryRun})...`);

  while (true) {
    if (limit && stats.txProcessed >= limit) break;

    batchNum++;
    const currentBatchSize = limit ? Math.min(batchSize, limit - stats.txProcessed) : batchSize;

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
        // Fetch transaction receipt
        const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
        const renewerAddress = tx.from.toLowerCase();

        // Parse all renewal-related events from the receipt
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

            // Look up ens_name_id
            const ensNameResult = await pool.query('SELECT id FROM ens_names WHERE name = $1', [fullName]);
            if (ensNameResult.rows.length === 0) {
              stats.skipped++;
              continue;
            }

            const ensNameId = ensNameResult.rows[0].id;
            const renewalDate = rows[0]?.timestamp || new Date();

            if (dryRun) {
              console.log(`  [DRY-RUN] Would insert renewal: ${fullName}, cost=${costWei}, referrer=${referrer || 'none'}`);
              stats.renewalsInserted++;
              continue;
            }

            try {
              await pool.query(
                `INSERT INTO renewals (
                  ens_name_id, renewer_address, cost_wei,
                  new_expiry_date, referrer, name_length,
                  transaction_hash, block_number, renewal_date, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING`,
                [
                  ensNameId, renewerAddress, costWei,
                  expiryDate, referrer, nameLength,
                  txHash, log.blockNumber?.toString(),
                  renewalDate,
                  JSON.stringify({ source: 'backfill_controller', version: isV2 ? 'v2' : 'original' }),
                ]
              );
              stats.renewalsInserted++;
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
              stats.skipped++;
              continue;
            }

            const ensNameId = ensNameResult.rows[0].id;
            const newExpiryDate = ensNameResult.rows[0].expiry_date || rows[0]?.timestamp || new Date();
            const renewalDate = rows[0]?.timestamp || new Date();

            if (dryRun) {
              console.log(`  [DRY-RUN] Would insert RenewalReferred: ${fullName}, cost=${costWei}, referrer=${referrer}`);
              stats.renewalsInserted++;
              continue;
            }

            try {
              await pool.query(
                `INSERT INTO renewals (
                  ens_name_id, renewer_address, cost_wei, duration_seconds,
                  new_expiry_date, referrer, name_length,
                  transaction_hash, block_number, renewal_date, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING`,
                [
                  ensNameId, renewerAddress, costWei, durationSeconds,
                  newExpiryDate, referrer, nameLength,
                  txHash, log.blockNumber?.toString(),
                  renewalDate,
                  JSON.stringify({ source: 'backfill_event_emitter' }),
                ]
              );
              stats.renewalsInserted++;
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

    console.log(`Batch ${batchNum}: ${stats.txProcessed} txs processed | ${stats.renewalsInserted} renewals inserted | ${stats.skipped} skipped | ${stats.alreadyExists} already exist | ${stats.failed} failed`);

    // Rate limit delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\nDone!');
  console.log(`Processed: ${stats.txProcessed}, Renewals inserted: ${stats.renewalsInserted}, Skipped: ${stats.skipped}, Already exist: ${stats.alreadyExists}, Failed: ${stats.failed}`);
}

async function main() {
  console.log('Backfill renewals script starting...');

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

    const countResult = await pool.query(`SELECT COUNT(*) FROM transactions WHERE transaction_type = 'renewal'`);
    console.log(`Total renewal transactions to process: ${countResult.rows[0].count}`);

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
