#!/usr/bin/env tsx

/**
 * Backfill Registration Referrers
 *
 * Processes existing registrations where referrer IS NULL, fetches their
 * on-chain receipts, and parses Controller V2 NameRegistered events
 * to extract the referrer field.
 *
 * Most older registrations went through the original controller and won't
 * have a referrer. The script gracefully skips those.
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node dist/wal-listener/src/scripts/backfill-registration-referrers.js [options]
 *
 * Options:
 *   --dry-run              Preview without updating
 *   --batch-size <n>       Registrations per batch (default: 50)
 *   --limit <n>            Maximum registrations to process
 *   --from-block <n>       Only process registrations at or after this block number
 *   --verbose              Show detailed logs
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';
import { createPublicClient, http, decodeEventLog, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

// V2 Controller NameRegistered event (has referrer param)
const CONTROLLER_V2_ABI = parseAbi([
  'event NameRegistered(string label, bytes32 indexed labelhash, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires, bytes32 referrer)',
]);

// Use the V2 controller address (second in the list)
const V2_CONTROLLER_ADDRESS = config.blockchain.ensControllerAddresses[1]?.toLowerCase()
  || '0x59e16fccd424cc24e280be16e11bcd56fb0ce547';

interface Options {
  dryRun: boolean;
  batchSize: number;
  limit: number | undefined;
  fromBlock: number | undefined;
  verbose: boolean;
}

interface Stats {
  processed: number;
  updated: number;
  noReferrer: number;
  failed: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillRegistrationReferrers(options: Options) {
  const pool = getPostgresPool();
  const startTime = Date.now();

  const stats: Stats = { processed: 0, updated: 0, noReferrer: 0, failed: 0 };

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  try {
    console.log('\n================================================================================');
    console.log('Backfill Registration Referrers Script');
    console.log('================================================================================\n');
    console.log(`Mode:              ${options.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log(`Batch size:        ${options.batchSize} registrations`);
    console.log(`Limit:             ${options.limit || 'unlimited'}`);
    console.log(`From block:        ${options.fromBlock || 'none (all blocks)'}`);
    console.log(`Verbose:           ${options.verbose ? 'YES' : 'NO'}`);
    console.log(`V2 Controller:     ${V2_CONTROLLER_ADDRESS}`);
    console.log('');

    const blockFilter = options.fromBlock ? `AND r.block_number >= ${Number(options.fromBlock)}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM registrations r WHERE r.referrer IS NULL ${blockFilter}`
    );
    console.log(`Registrations without referrer: ${countResult.rows[0].count}\n`);

    let lastId: number | null = null;
    let batchNum = 0;

    while (true) {
      if (options.limit && stats.processed >= options.limit) break;

      batchNum++;
      const currentBatchSize = options.limit
        ? Math.min(options.batchSize, options.limit - stats.processed)
        : options.batchSize;

      // Fetch batch of registrations without referrer
      const batchResult: any = lastId === null
        ? await pool.query(
            `SELECT r.id, r.transaction_hash, r.ens_name_id, en.name
             FROM registrations r
             JOIN ens_names en ON r.ens_name_id = en.id
             WHERE r.referrer IS NULL ${blockFilter}
             ORDER BY r.id ASC
             LIMIT $1`,
            [currentBatchSize]
          )
        : await pool.query(
            `SELECT r.id, r.transaction_hash, r.ens_name_id, en.name
             FROM registrations r
             JOIN ens_names en ON r.ens_name_id = en.id
             WHERE r.referrer IS NULL AND r.id > $1 ${blockFilter}
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
          // Small delay between RPC calls to reduce memory pressure
          await sleep(50);

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
            if (options.verbose) {
              console.log(`  [NO REFERRER] ${row.name} - no V2 event found`);
            }
            continue;
          }

          if (options.dryRun) {
            if (options.verbose) {
              console.log(`  [DRY-RUN] Would update ${row.name}: referrer=${referrer}`);
            }
            stats.updated++;
            continue;
          }

          await pool.query(
            `UPDATE registrations SET referrer = $1
             WHERE transaction_hash = $2 AND ens_name_id = $3`,
            [referrer, row.transaction_hash, row.ens_name_id]
          );
          stats.updated++;

          if (options.verbose) {
            console.log(`  [UPDATED] ${row.name}: referrer=${referrer}`);
          }
        } catch (error: any) {
          console.error(`  Error processing registration ${row.id} (${row.name}): ${error.message}`);
          stats.failed++;
        }
      }

      const memLine = batchNum % 10 === 0
        ? ` | heap ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        : '';
      console.log(
        `Batch ${batchNum}: ${stats.processed} processed | ` +
        `${stats.updated} updated | ` +
        `${stats.noReferrer} no referrer | ` +
        `${stats.failed} failed${memLine}`
      );

      await sleep(500);
    }

    const duration = Date.now() - startTime;
    console.log('\n================================================================================');
    console.log('Backfill Registration Referrers Summary');
    console.log('================================================================================');
    console.log(`Processed:     ${stats.processed}`);
    console.log(`Updated:       ${stats.updated}`);
    console.log(`No referrer:   ${stats.noReferrer}`);
    console.log(`Failed:        ${stats.failed}`);
    console.log(`Duration:      ${Math.floor(duration / 1000)}s`);
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
    fromBlock: undefined,
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
    } else if (arg === '--from-block' && args[i + 1]) {
      options.fromBlock = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return options;
}

const opts = parseArgs();
backfillRegistrationReferrers(opts).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
