#!/usr/bin/env tsx

/**
 * Backfill Missed Offer Acceptance Sales
 *
 * Scans the Seaport 1.6 contract for OrderFulfilled events where the ENS token
 * is in the `consideration` array (offer acceptances) rather than the `offer` array
 * (standard listing fulfillments). These were previously missed by the Seaport indexer
 * which only checked the `offer` array for ENS tokens.
 *
 * For each missed sale:
 * 1. Resolves the ENS name via The Graph (supports both labelhash and namehash)
 * 2. Creates a sale record via createSale() (triggers activity_history automatically)
 * 3. Updates last_sale_price/last_sale_date if this is the most recent sale
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node dist/wal-listener/src/scripts/backfill-offer-acceptance-sales.js [options]
 *
 * Options:
 *   --dry-run              Preview without inserting
 *   --start-block <n>      Starting block number (default: ~3 months ago)
 *   --end-block <n>        Ending block number (default: latest)
 *   --days <n>             Scan last N days (overrides --start-block)
 *   --batch-size <n>       Blocks per RPC call (default: 2000)
 *   --verbose              Show detailed logs
 *
 * Examples:
 *   # Dry run to see what would be backfilled
 *   npx tsx src/scripts/backfill-offer-acceptance-sales.ts --dry-run --verbose
 *
 *   # Scan last 7 days
 *   npx tsx src/scripts/backfill-offer-acceptance-sales.ts --days 7 --verbose
 *
 *   # Scan specific block range
 *   npx tsx src/scripts/backfill-offer-acceptance-sales.ts \
 *     --start-block 24000000 --end-block 24100000
 *
 *   # Full 3-month backfill
 *   npx tsx src/scripts/backfill-offer-acceptance-sales.ts
 */

import { getPostgresPool, closeAllConnections, config, createSale } from '../../../shared/src';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

// Seaport 1.6 OrderFulfilled event ABI
const SEAPORT_ABI = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
]);

const SEAPORT_ADDRESS = config.blockchain.seaportAddress as `0x${string}`;
const ENS_REGISTRAR = config.blockchain.ensRegistrarAddress.toLowerCase();
const ENS_NAME_WRAPPER = config.blockchain.ensNameWrapperAddress.toLowerCase();
const GRAPH_URL = config.theGraph.ensSubgraphUrl;

// ~7200 blocks per day (12 second block time)
const BLOCKS_PER_DAY = 7200n;
const DEFAULT_DAYS_BACK = 90; // 3 months

interface Options {
  dryRun: boolean;
  startBlock: bigint | null;
  endBlock: bigint | 'latest';
  days: number | null;
  batchSize: number;
  verbose: boolean;
}

interface Stats {
  eventsScanned: number;
  offerAcceptancesFound: number;
  alreadyInDb: number;
  inserted: number;
  lastSaleUpdated: number;
  nameNotFound: number;
  errors: number;
  blocksProcessed: bigint;
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

function isENSToken(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === ENS_REGISTRAR || lower === ENS_NAME_WRAPPER;
}

// Namehash of "eth" - used to filter labelhash queries to only .eth 2LDs
const ETH_NAMEHASH = '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae';

/**
 * Resolve a token ID to an ENS name via The Graph.
 *
 * Uses the same dual-lookup strategy as the indexer's ENS resolver:
 *   - Wrapped names (Name Wrapper ERC-1155): token ID is a namehash -> query domain(id:)
 *   - Unwrapped names (Base Registrar ERC-721): token ID is a labelhash -> query domains(where: { labelhash: })
 */
async function resolveTokenId(
  tokenId: string,
  isWrapped: boolean
): Promise<{ name: string; expiryDate: Date | null } | null> {
  const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
  const tokenIdAsHex = '0x' + hexString;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  try {
    let domain: any = null;

    if (isWrapped) {
      // Wrapped names: token ID is a namehash, look up by domain ID (exact match)
      const query = `
        query GetENSNameByNamehash($namehash: String!) {
          domain(id: $namehash) {
            name
            labelName
            registration { expiryDate }
          }
        }
      `;

      const response = await fetch(GRAPH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables: { namehash: tokenIdAsHex },
        }),
      });

      if (!response.ok) return null;
      const data = await response.json() as any;
      if (data.errors) return null;

      domain = data.data?.domain;
    } else {
      // Unwrapped names: token ID is a labelhash, search by labelhash field
      // Filter to .eth 2LDs only (parent = namehash("eth")) to prevent subname collisions
      const query = `
        query GetENSNameByLabelhash($labelhash: String!) {
          domains(where: { labelhash: $labelhash, parent: "${ETH_NAMEHASH}" }) {
            name
            labelName
            registration { expiryDate }
          }
        }
      `;

      const response = await fetch(GRAPH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables: { labelhash: tokenIdAsHex },
        }),
      });

      if (!response.ok) return null;
      const data = await response.json() as any;
      if (data.errors) return null;

      const domains = data.data?.domains || [];
      domain = domains.length > 0 ? domains[0] : null;
    }

    if (!domain) return null;

    const name = domain.name || domain.labelName;
    if (!name) return null;

    let expiryDate: Date | null = null;
    if (domain.registration?.expiryDate) {
      expiryDate = new Date(parseInt(domain.registration.expiryDate) * 1000);
    }

    return { name, expiryDate };
  } catch {
    return null;
  }
}

/**
 * Get block timestamp with caching
 */
async function getBlockTimestamp(
  client: ReturnType<typeof createPublicClient>,
  blockNumber: bigint
): Promise<Date> {
  if (blockTimestampCache.has(blockNumber)) {
    return blockTimestampCache.get(blockNumber)!;
  }

  const block = await client.getBlock({ blockNumber });
  const timestamp = new Date(Number(block.timestamp) * 1000);
  blockTimestampCache.set(blockNumber, timestamp);

  // Limit cache size
  if (blockTimestampCache.size > 10000) {
    const firstKey = blockTimestampCache.keys().next().value;
    if (firstKey !== undefined) {
      blockTimestampCache.delete(firstKey);
    }
  }

  return timestamp;
}

async function backfillOfferAcceptanceSales(options: Options) {
  const pool = getPostgresPool();
  const startTime = Date.now();

  const stats: Stats = {
    eventsScanned: 0,
    offerAcceptancesFound: 0,
    alreadyInDb: 0,
    inserted: 0,
    lastSaleUpdated: 0,
    nameNotFound: 0,
    errors: 0,
    blocksProcessed: 0n,
  };

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  try {
    console.log('\n================================================================================');
    console.log('Backfill Missed Offer Acceptance Sales');
    console.log('================================================================================\n');
    console.log(`Mode:          ${options.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log(`Batch size:    ${options.batchSize} blocks per RPC call`);
    console.log(`Verbose:       ${options.verbose ? 'YES' : 'NO'}`);
    console.log(`Seaport:       ${SEAPORT_ADDRESS}`);
    console.log(`ENS Registrar: ${ENS_REGISTRAR}`);
    console.log(`Name Wrapper:  ${ENS_NAME_WRAPPER}`);
    console.log('');

    // Determine block range
    const latestBlock = await client.getBlockNumber();
    let startBlock: bigint;
    let endBlock: bigint;

    if (options.days !== null) {
      startBlock = latestBlock - (BigInt(options.days) * BLOCKS_PER_DAY);
      console.log(`Start block:   ${formatNumber(startBlock)} (${options.days} days ago)`);
    } else if (options.startBlock !== null) {
      startBlock = options.startBlock;
      console.log(`Start block:   ${formatNumber(startBlock)} (specified)`);
    } else {
      startBlock = latestBlock - (BigInt(DEFAULT_DAYS_BACK) * BLOCKS_PER_DAY);
      console.log(`Start block:   ${formatNumber(startBlock)} (default: ${DEFAULT_DAYS_BACK} days ago)`);
    }

    if (options.endBlock === 'latest') {
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
        console.log(`\nFetching Seaport logs for blocks ${formatNumber(currentBlock)} - ${formatNumber(actualEndBlock)}...`);
      }

      try {
        const logs = await client.getLogs({
          address: SEAPORT_ADDRESS,
          event: SEAPORT_ABI[0],
          fromBlock: currentBlock,
          toBlock: actualEndBlock,
        });

        stats.eventsScanned += logs.length;

        if (options.verbose && logs.length > 0) {
          console.log(`  Found ${logs.length} OrderFulfilled events`);
        }

        for (const log of logs) {
          try {
            await processOrderFulfilled(log, pool, client, stats, options);
          } catch (logError: any) {
            stats.errors++;
            if (options.verbose) {
              console.error(`  Error processing log at block ${log.blockNumber}: ${logError.message}`);
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
            `Scanned: ${formatNumber(stats.eventsScanned)} | ` +
            `Offer acceptances: ${formatNumber(stats.offerAcceptancesFound)} | ` +
            `Inserted: ${formatNumber(stats.inserted)} | ` +
            `Rate: ${rate.toFixed(1)} blocks/sec | ` +
            `ETA: ${formatDuration(eta)}`
          );
          lastProgressUpdate = now;
        }

      } catch (batchError: any) {
        console.error(`\nError fetching logs for blocks ${formatNumber(currentBlock)} - ${formatNumber(actualEndBlock)}: ${batchError.message}`);

        // Rate limit handling
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
    console.log('Backfill Summary');
    console.log('================================================================================');
    console.log(`Block range:           ${formatNumber(startBlock)} - ${formatNumber(endBlock)}`);
    console.log(`OrderFulfilled events: ${formatNumber(stats.eventsScanned)}`);
    console.log(`Offer acceptances:     ${formatNumber(stats.offerAcceptancesFound)}`);
    console.log(`Already in DB:         ${formatNumber(stats.alreadyInDb)}`);
    console.log(`Sales inserted:        ${formatNumber(stats.inserted)}`);
    console.log(`Last sale updated:     ${formatNumber(stats.lastSaleUpdated)}`);
    console.log(`Name not found:        ${formatNumber(stats.nameNotFound)}`);
    console.log(`Errors:                ${formatNumber(stats.errors)}`);
    console.log(`Duration:              ${formatDuration(duration)}`);
    console.log(`Rate:                  ${(Number(stats.blocksProcessed) / (duration / 1000)).toFixed(1)} blocks/sec`);
    console.log('');

    if (options.dryRun) {
      console.log('DRY RUN - No changes made');
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

async function processOrderFulfilled(
  log: any,
  pool: ReturnType<typeof getPostgresPool>,
  client: ReturnType<typeof createPublicClient>,
  stats: Stats,
  options: Options
) {
  const { orderHash, offerer, recipient, offer, consideration } = log.args;
  if (!offer || !consideration) return;

  // We're specifically looking for offer acceptances:
  // ENS token is in `consideration` (buyer offered WETH, seller accepted by sending ENS)
  // and NOT in `offer` (that would be a standard listing fulfillment, already handled)
  const ensInOffer = offer?.some((item: any) =>
    item.token && isENSToken(item.token)
  );

  const ensConsiderationItems = consideration?.filter((item: any) =>
    item.token && isENSToken(item.token)
  ) || [];

  if (ensConsiderationItems.length === 0 || ensInOffer) {
    // Not an offer acceptance ENS sale - skip
    return;
  }

  stats.offerAcceptancesFound++;

  // For offer acceptances:
  //   offerer = buyer (the person who created the WETH offer)
  //   recipient = seller (the person who fulfilled by sending ENS)
  const sellerAddress = recipient.toLowerCase();
  const buyerAddress = offerer.toLowerCase();

  // Calculate price from the `offer` array (the buyer's WETH/ETH payment)
  let totalPrice = BigInt(0);
  let currencyAddress = '0x0000000000000000000000000000000000000000';

  for (const payItem of offer) {
    const payToken = payItem.token?.toLowerCase() || '';
    if (!isENSToken(payToken) && payItem.amount) {
      totalPrice += BigInt(payItem.amount.toString());
      if (currencyAddress === '0x0000000000000000000000000000000000000000' && payToken) {
        currencyAddress = payToken;
      }
    }
  }

  const priceWei = totalPrice.toString();

  // Process each ENS token in consideration
  for (const ensItem of ensConsiderationItems) {
    const tokenId = ensItem.identifier.toString();
    const tokenAddress = ensItem.token.toLowerCase();
    const isWrapped = tokenAddress === ENS_NAME_WRAPPER;

    if (options.verbose) {
      const priceEth = (Number(totalPrice) / 1e18).toFixed(4);
      console.log(`  Offer acceptance: token=${tokenId} (${isWrapped ? 'wrapped' : 'unwrapped'}) price=${priceEth} ETH/WETH tx=${log.transactionHash}`);
    }

    // Check if sale already exists
    const existingResult = await pool.query(
      'SELECT id FROM sales WHERE transaction_hash = $1 OR order_hash = $2 LIMIT 1',
      [log.transactionHash, orderHash]
    );

    if (existingResult.rows.length > 0) {
      stats.alreadyInDb++;
      if (options.verbose) {
        console.log(`    Already in DB (sale id: ${existingResult.rows[0].id}), skipping`);
      }
      continue;
    }

    // Resolve name via The Graph
    const nameData = await resolveTokenId(tokenId, isWrapped);
    if (!nameData?.name) {
      stats.nameNotFound++;
      if (options.verbose) {
        console.log(`    Could not resolve name for tokenId ${tokenId}, skipping`);
      }
      continue;
    }

    const ensName = nameData.name.endsWith('.eth') ? nameData.name : `${nameData.name}.eth`;

    if (options.verbose) {
      console.log(`    Name: ${ensName}`);
    }

    // Find ENS name in database
    let ensNameResult = await pool.query(
      'SELECT id, last_sale_date FROM ens_names WHERE name = $1',
      [ensName]
    );

    if (ensNameResult.rows.length === 0) {
      // Try by token_id
      ensNameResult = await pool.query(
        'SELECT id, last_sale_date FROM ens_names WHERE token_id = $1',
        [tokenId]
      );
    }

    if (ensNameResult.rows.length === 0) {
      stats.nameNotFound++;
      if (options.verbose) {
        console.log(`    ENS name not found in database: ${ensName}, skipping`);
      }
      continue;
    }

    const ensNameId = ensNameResult.rows[0].id;
    const currentLastSaleDate: Date | null = ensNameResult.rows[0].last_sale_date;

    // Get sale date from block timestamp
    const saleDate = await getBlockTimestamp(client, log.blockNumber!);

    if (options.verbose) {
      const priceEth = (Number(totalPrice) / 1e18).toFixed(4);
      console.log(`    Creating sale: ${ensName} for ${priceEth} ETH/WETH (${saleDate.toISOString()})`);
    }

    if (options.dryRun) {
      stats.inserted++;
      continue;
    }

    // Create the sale record
    try {
      const saleResult = await createSale({
        ensNameId,
        sellerAddress,
        buyerAddress,
        salePriceWei: priceWei,
        currencyAddress,
        transactionHash: log.transactionHash!,
        blockNumber: Number(log.blockNumber),
        orderHash,
        orderData: {
          offer: serializeBigInts(offer),
          consideration: serializeBigInts(consideration),
        },
        source: 'opensea',
        saleDate,
      });

      if (saleResult) {
        stats.inserted++;
        if (options.verbose) {
          console.log(`    Sale created (id: ${saleResult.id})`);
        }
      } else {
        stats.alreadyInDb++;
        if (options.verbose) {
          console.log(`    Sale already exists (ON CONFLICT)`);
        }
      }
    } catch (error: any) {
      stats.errors++;
      if (options.verbose) {
        console.error(`    Error creating sale: ${error.message}`);
      }
      continue;
    }

    // Update last_sale_price and last_sale_date if this sale is newer
    if (!currentLastSaleDate || saleDate > currentLastSaleDate) {
      try {
        const updateResult = await pool.query(`
          UPDATE ens_names
          SET last_sale_price = $1,
              last_sale_date = $2,
              updated_at = NOW()
          WHERE id = $3
            AND (last_sale_date IS NULL OR last_sale_date < $2)
        `, [priceWei, saleDate, ensNameId]);

        if (updateResult.rowCount && updateResult.rowCount > 0) {
          stats.lastSaleUpdated++;
          if (options.verbose) {
            console.log(`    Updated last_sale_price and last_sale_date`);
          }
        }
      } catch (error: any) {
        if (options.verbose) {
          console.error(`    Error updating last_sale: ${error.message}`);
        }
      }
    }
  }
}

function serializeBigInts(obj: any): any {
  if (typeof obj === 'bigint') {
    return obj.toString();
  } else if (Array.isArray(obj)) {
    return obj.map(item => serializeBigInts(item));
  } else if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = serializeBigInts(value);
    }
    return result;
  }
  return obj;
}

// Parse command line arguments
function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    dryRun: false,
    startBlock: null,
    endBlock: 'latest',
    days: null,
    batchSize: 2000,
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
    } else if (arg === '--days' && args[i + 1]) {
      options.days = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Backfill Missed Offer Acceptance Sales

Scans the Seaport contract for ENS sales where the buyer's offer was accepted
(ENS token in consideration, not offer). These were previously missed by the
Seaport indexer.

Usage:
  npx tsx src/scripts/backfill-offer-acceptance-sales.ts [options]

Options:
  --dry-run              Preview without inserting
  --start-block <n>      Starting block number (default: ~90 days ago)
  --end-block <n>        Ending block number (default: latest)
  --days <n>             Scan last N days (overrides --start-block)
  --batch-size <n>       Blocks per RPC call (default: 2000)
  --verbose              Show detailed logs
  --help, -h             Show this help message

Examples:
  # Dry run to see what was missed
  npx tsx src/scripts/backfill-offer-acceptance-sales.ts --dry-run --verbose

  # Scan last 7 days
  npx tsx src/scripts/backfill-offer-acceptance-sales.ts --days 7 --verbose

  # Full 3-month backfill
  npx tsx src/scripts/backfill-offer-acceptance-sales.ts
`);
      process.exit(0);
    }
  }

  return options;
}

// Main execution
const options = parseArgs();
backfillOfferAcceptanceSales(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
