#!/usr/bin/env tsx

/**
 * Backfill Historical Registrations Script
 *
 * This script backfills historical ENS registration data by querying on-chain
 * NameRegistered events from the ENS Controller contract and loading them
 * into the `registrations` table.
 *
 * The ENS Controller contract (0x253553366Da8546fC250F225fe3d25d0C782303b) was
 * deployed in May 2022 and emits NameRegistered events with cost data (baseCost,
 * premium, expires).
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node dist/wal-listener/src/scripts/backfill-registrations.js [options]
 *
 * Options:
 *   --dry-run              Preview without inserting
 *   --start-block <n>      Starting block number (default: auto-resume or 14836000)
 *   --end-block <n>        Ending block number (default: latest)
 *   --batch-size <n>       Blocks per RPC call (default: 2000)
 *   --concurrency <n>      Parallel RPC requests (default: 3)
 *   --verbose              Show detailed logs
 *
 * Examples:
 *   # Dry run first
 *   node dist/wal-listener/src/scripts/backfill-registrations.js --dry-run --verbose
 *
 *   # Run with small block range to test
 *   node dist/wal-listener/src/scripts/backfill-registrations.js \
 *     --start-block 19000000 --end-block 19001000
 *
 *   # Full backfill (will take time)
 *   node dist/wal-listener/src/scripts/backfill-registrations.js
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';
import { createPublicClient, http, parseAbi, decodeEventLog, type Log } from 'viem';
import { mainnet } from 'viem/chains';

// ENS Controller contract (deployed May 2022 with cost data)
const ENS_CONTROLLER_ADDRESS = '0x253553366Da8546fC250F225fe3d25d0C782303b';

const ENS_CONTROLLER_ABI = parseAbi([
  'event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)',
]);

// Controller deployment block (May 2022)
const DEFAULT_START_BLOCK = 14836000n;

interface Options {
  dryRun: boolean;
  startBlock: bigint | null;
  endBlock: bigint | 'latest';
  batchSize: number;
  concurrency: number;
  verbose: boolean;
}

interface Stats {
  eventsFound: number;
  inserted: number;
  alreadyExists: number;
  missingNames: number;
  errors: number;
  blocksProcessed: bigint;
}

interface MissingName {
  name: string;
  blockNumber: bigint;
  transactionHash: string;
}

// Cache for block timestamps to avoid redundant RPC calls
const blockTimestampCache = new Map<bigint, Date>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatNumber(n: number | bigint): string {
  return n.toLocaleString();
}

async function backfillRegistrations(options: Options) {
  const pool = getPostgresPool();
  const startTime = Date.now();

  const stats: Stats = {
    eventsFound: 0,
    inserted: 0,
    alreadyExists: 0,
    missingNames: 0,
    errors: 0,
    blocksProcessed: 0n,
  };

  const missingNamesList: MissingName[] = [];

  // Create viem client
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  try {
    console.log('\n================================================================================');
    console.log('Backfill Registrations Script');
    console.log('================================================================================\n');
    console.log(`Mode:          ${options.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log(`Batch size:    ${options.batchSize} blocks per RPC call`);
    console.log(`Concurrency:   ${options.concurrency} parallel requests`);
    console.log(`Verbose:       ${options.verbose ? 'YES' : 'NO'}`);
    console.log('');

    // Determine start block
    let startBlock: bigint;
    if (options.startBlock !== null) {
      startBlock = options.startBlock;
      console.log(`Start block:   ${formatNumber(startBlock)} (specified)`);
    } else {
      // Try to auto-resume from highest block in registrations table
      const resumeResult = await pool.query(
        'SELECT COALESCE(MAX(block_number), 0) as max_block FROM registrations'
      );
      const maxBlock = BigInt(resumeResult.rows[0].max_block || 0);

      if (maxBlock > 0n) {
        startBlock = maxBlock + 1n;
        console.log(`Start block:   ${formatNumber(startBlock)} (auto-resume from registrations table)`);
      } else {
        startBlock = DEFAULT_START_BLOCK;
        console.log(`Start block:   ${formatNumber(startBlock)} (default - controller deployment)`);
      }
    }

    // Determine end block
    let endBlock: bigint;
    if (options.endBlock === 'latest') {
      const latestBlock = await client.getBlockNumber();
      endBlock = latestBlock;
      console.log(`End block:     ${formatNumber(endBlock)} (latest)`);
    } else {
      endBlock = options.endBlock;
      console.log(`End block:     ${formatNumber(endBlock)} (specified)`);
    }

    if (startBlock >= endBlock) {
      console.log('\nNo blocks to process (start >= end). Exiting.');
      return;
    }

    const totalBlocks = endBlock - startBlock;
    console.log(`Total blocks:  ${formatNumber(totalBlocks)}`);
    console.log('');

    // Process in batches
    let currentBlock = startBlock;
    let lastProgressUpdate = Date.now();

    while (currentBlock < endBlock) {
      const batchEndBlock = currentBlock + BigInt(options.batchSize) - 1n;
      const actualEndBlock = batchEndBlock > endBlock ? endBlock : batchEndBlock;

      if (options.verbose) {
        console.log(`\nFetching logs for blocks ${formatNumber(currentBlock)} - ${formatNumber(actualEndBlock)}...`);
      }

      try {
        // Fetch NameRegistered logs for this block range
        const logs = await client.getLogs({
          address: ENS_CONTROLLER_ADDRESS as `0x${string}`,
          event: ENS_CONTROLLER_ABI[0],
          fromBlock: currentBlock,
          toBlock: actualEndBlock,
        });

        if (options.verbose && logs.length > 0) {
          console.log(`  Found ${logs.length} NameRegistered events`);
        }

        stats.eventsFound += logs.length;

        // Process each log
        for (const log of logs) {
          try {
            await processLog(log, pool, client, stats, missingNamesList, options);
          } catch (logError: any) {
            stats.errors++;
            if (options.verbose) {
              console.error(`  Error processing log: ${logError.message}`);
            }
          }
        }

        stats.blocksProcessed = actualEndBlock - startBlock + 1n;

        // Progress update every 10 seconds
        const now = Date.now();
        if (now - lastProgressUpdate > 10000) {
          const progress = Number(stats.blocksProcessed) / Number(totalBlocks) * 100;
          const elapsed = now - startTime;
          const rate = Number(stats.blocksProcessed) / (elapsed / 1000);
          const remainingBlocks = Number(totalBlocks) - Number(stats.blocksProcessed);
          const eta = rate > 0 ? remainingBlocks / rate * 1000 : 0;

          console.log(
            `Progress: ${progress.toFixed(1)}% | ` +
            `Blocks: ${formatNumber(stats.blocksProcessed)}/${formatNumber(totalBlocks)} | ` +
            `Events: ${formatNumber(stats.eventsFound)} | ` +
            `Inserted: ${formatNumber(stats.inserted)} | ` +
            `Rate: ${rate.toFixed(1)} blocks/sec | ` +
            `ETA: ${formatDuration(eta)}`
          );
          lastProgressUpdate = now;
        }

      } catch (batchError: any) {
        console.error(`\nError fetching logs for blocks ${formatNumber(currentBlock)} - ${formatNumber(actualEndBlock)}: ${batchError.message}`);

        // Rate limit handling - exponential backoff
        if (batchError.message?.includes('429') || batchError.message?.includes('rate limit')) {
          console.log('Rate limited, waiting 5 seconds...');
          await sleep(5000);
          continue; // Retry this batch
        }

        stats.errors++;
      }

      currentBlock = actualEndBlock + 1n;

      // Small delay between batches to avoid rate limits
      await sleep(100);
    }

    // Print summary
    const duration = Date.now() - startTime;

    console.log('\n================================================================================');
    console.log('Backfill Registrations Summary');
    console.log('================================================================================');
    console.log(`Block range:     ${formatNumber(startBlock)} - ${formatNumber(endBlock)}`);
    console.log(`Total events:    ${formatNumber(stats.eventsFound)}`);
    console.log(`Inserted:        ${formatNumber(stats.inserted)}`);
    console.log(`Already exists:  ${formatNumber(stats.alreadyExists)}`);
    console.log(`Missing names:   ${formatNumber(stats.missingNames)}`);
    console.log(`Errors:          ${formatNumber(stats.errors)}`);
    console.log(`Duration:        ${formatDuration(duration)}`);
    console.log(`Rate:            ${(stats.eventsFound / (duration / 1000)).toFixed(1)} events/sec`);
    console.log('');

    if (options.dryRun) {
      console.log('DRY RUN - No changes made');
    }

    console.log('================================================================================\n');

    // Export missing names if any
    if (missingNamesList.length > 0) {
      const fs = require('fs');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = `backfill-registrations-missing-${timestamp}.json`;

      fs.writeFileSync(outputFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        count: missingNamesList.length,
        names: missingNamesList.slice(0, 1000), // Limit to first 1000
      }, null, 2));

      console.log(`Missing names exported to: ${outputFile}`);
    }

  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await closeAllConnections();
  }
}

async function processLog(
  log: Log,
  pool: ReturnType<typeof getPostgresPool>,
  client: ReturnType<typeof createPublicClient>,
  stats: Stats,
  missingNamesList: MissingName[],
  options: Options
) {
  // Decode the event
  const decodedLog = decodeEventLog({
    abi: ENS_CONTROLLER_ABI,
    data: log.data,
    topics: log.topics as any,
  });

  const { name, label, owner, baseCost, premium, expires } = decodedLog.args as {
    name: string;
    label: `0x${string}`;
    owner: `0x${string}`;
    baseCost: bigint;
    premium: bigint;
    expires: bigint;
  };

  // Convert costs to string (wei precision)
  const baseCostWei = baseCost.toString();
  const premiumWei = premium.toString();
  const totalCostWei = (baseCost + premium).toString();

  // Name length (excluding .eth)
  const nameLength = name.length;
  const fullName = `${name}.eth`;

  // Get registrant from transaction (the actual payer)
  let registrantAddress = owner.toLowerCase();
  if (log.transactionHash) {
    try {
      const tx = await client.getTransaction({ hash: log.transactionHash as `0x${string}` });
      if (tx && tx.from) {
        registrantAddress = tx.from.toLowerCase();
      }
    } catch (txError: any) {
      if (options.verbose) {
        console.log(`    Could not fetch transaction, using owner as registrant: ${txError.message}`);
      }
    }
  }

  // Get block timestamp for registration date (use cache)
  let registrationDate: Date;
  const blockNumber = log.blockNumber!;

  if (blockTimestampCache.has(blockNumber)) {
    registrationDate = blockTimestampCache.get(blockNumber)!;
  } else {
    try {
      const block = await client.getBlock({ blockNumber });
      registrationDate = new Date(Number(block.timestamp) * 1000);
      blockTimestampCache.set(blockNumber, registrationDate);

      // Limit cache size
      if (blockTimestampCache.size > 10000) {
        const firstKey = blockTimestampCache.keys().next().value;
        if (firstKey !== undefined) {
          blockTimestampCache.delete(firstKey);
        }
      }
    } catch (blockError: any) {
      if (options.verbose) {
        console.log(`    Could not fetch block, using current time: ${blockError.message}`);
      }
      registrationDate = new Date();
    }
  }

  // Expiry date from event
  const expiryDate = new Date(Number(expires) * 1000);

  if (options.verbose) {
    console.log(`  Processing: ${fullName} (block ${blockNumber})`);
    console.log(`    Cost: ${baseCostWei} + ${premiumWei} = ${totalCostWei} wei`);
    console.log(`    Registrant: ${registrantAddress}, Owner: ${owner.toLowerCase()}`);
  }

  // Find the ens_name_id for this name
  const ensNameResult = await pool.query(
    'SELECT id FROM ens_names WHERE name = $1',
    [fullName]
  );

  if (ensNameResult.rows.length === 0) {
    // Name not in database
    stats.missingNames++;
    missingNamesList.push({
      name: fullName,
      blockNumber,
      transactionHash: log.transactionHash || '',
    });

    if (options.verbose) {
      console.log(`    ⚠️  Name not found in ens_names table, skipping`);
    }
    return;
  }

  const ensNameId = ensNameResult.rows[0].id;

  if (options.dryRun) {
    stats.inserted++;
    if (options.verbose) {
      console.log(`    ✅ Would insert registration (dry run)`);
    }
    return;
  }

  // Insert registration record
  try {
    const insertResult = await pool.query(
      `INSERT INTO registrations (
        ens_name_id, registrant_address, owner_address,
        base_cost_wei, premium_wei, total_cost_wei,
        name_length, transaction_hash, block_number,
        registration_date, expiry_date, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
      RETURNING id`,
      [
        ensNameId,
        registrantAddress,
        owner.toLowerCase(),
        baseCostWei,
        premiumWei,
        totalCostWei,
        nameLength,
        log.transactionHash,
        blockNumber.toString(),
        registrationDate,
        expiryDate,
        JSON.stringify({ label: label }),
      ]
    );

    if (insertResult.rows.length > 0) {
      stats.inserted++;
      if (options.verbose) {
        console.log(`    ✅ Inserted registration (id: ${insertResult.rows[0].id})`);
      }
    } else {
      stats.alreadyExists++;
      if (options.verbose) {
        console.log(`    ⏭️  Already exists, skipped`);
      }
    }
  } catch (insertError: any) {
    stats.errors++;
    if (options.verbose) {
      console.error(`    ❌ Insert error: ${insertError.message}`);
    }
  }
}

// Parse command line arguments
function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    dryRun: false,
    startBlock: null,
    endBlock: 'latest',
    batchSize: 2000,
    concurrency: 3,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--start-block' && args[i + 1]) {
      options.startBlock = BigInt(args[i + 1]);
      i++;
    } else if (arg === '--end-block' && args[i + 1]) {
      const value = args[i + 1];
      options.endBlock = value === 'latest' ? 'latest' : BigInt(value);
      i++;
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--concurrency' && args[i + 1]) {
      options.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Backfill Historical Registrations Script

Usage:
  node dist/wal-listener/src/scripts/backfill-registrations.js [options]

Options:
  --dry-run              Preview without inserting
  --start-block <n>      Starting block number (default: auto-resume or 14836000)
  --end-block <n>        Ending block number (default: latest)
  --batch-size <n>       Blocks per RPC call (default: 2000)
  --concurrency <n>      Parallel RPC requests (default: 3)
  --verbose              Show detailed logs
  --help, -h             Show this help message

Examples:
  # Dry run first
  node dist/wal-listener/src/scripts/backfill-registrations.js --dry-run --verbose

  # Run with small block range to test
  node dist/wal-listener/src/scripts/backfill-registrations.js \\
    --start-block 19000000 --end-block 19001000

  # Full backfill
  node dist/wal-listener/src/scripts/backfill-registrations.js
`);
      process.exit(0);
    }
  }

  return options;
}

// Main execution
const options = parseArgs();
backfillRegistrations(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
