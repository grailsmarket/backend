#!/usr/bin/env node
/**
 * Script to find missed Name Wrapper sales
 *
 * Scans the Seaport contract for OrderFulfilled events where the offer
 * contains the ENS Name Wrapper, then checks which ones are missing from our database.
 *
 * Usage:
 *   npx tsx src/scripts/find-missed-wrapper-sales.ts --from-block 19000000 --to-block latest --output missed-sales.json
 *   npx tsx src/scripts/find-missed-wrapper-sales.ts --days 30 --output missed-sales.json
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { writeFileSync } from 'fs';
import { getPostgresPool, config } from '../../../shared/src';

// Parse command line args
const args = process.argv.slice(2);
let fromBlock: bigint | undefined;
let toBlock: bigint | 'latest' = 'latest';
let daysBack: number | undefined;
let outputFile: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--from-block' && args[i + 1]) {
    fromBlock = BigInt(args[i + 1]);
    i++;
  } else if (args[i] === '--to-block' && args[i + 1]) {
    toBlock = args[i + 1] === 'latest' ? 'latest' : BigInt(args[i + 1]);
    i++;
  } else if (args[i] === '--days' && args[i + 1]) {
    daysBack = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  }
}

const SEAPORT_ADDRESS = config.blockchain.seaportAddress;
const NAME_WRAPPER_ADDRESS = config.blockchain.ensNameWrapperAddress.toLowerCase();

const SEAPORT_ABI = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
]);

const client = createPublicClient({
  chain: mainnet,
  transport: http(config.blockchain.rpcUrl),
});

interface MissedSale {
  transactionHash: string;
  blockNumber: bigint;
  orderHash: string;
  offerer: string;
  recipient: string;
  tokenId: string;
  priceWei: string;
  currencyAddress: string;
  timestamp?: Date;
}

async function getBlockForDaysAgo(days: number): Promise<bigint> {
  const currentBlock = await client.getBlockNumber();
  // Approximate: ~7200 blocks per day (12 second block time)
  const blocksPerDay = 7200n;
  return currentBlock - (BigInt(days) * blocksPerDay);
}

async function findMissedSales(): Promise<void> {
  const pool = getPostgresPool();

  console.log('Finding missed Name Wrapper sales...\n');
  console.log(`Seaport Address: ${SEAPORT_ADDRESS}`);
  console.log(`Name Wrapper Address: ${NAME_WRAPPER_ADDRESS}\n`);

  // Determine block range
  const latestBlock = await client.getBlockNumber();

  if (daysBack) {
    fromBlock = await getBlockForDaysAgo(daysBack);
    console.log(`Scanning last ${daysBack} days (from block ${fromBlock})`);
  } else if (!fromBlock) {
    // Default to last 30 days
    fromBlock = await getBlockForDaysAgo(30);
    console.log(`No block range specified, defaulting to last 30 days (from block ${fromBlock})`);
  }

  const endBlock = toBlock === 'latest' ? latestBlock : toBlock;
  console.log(`Block range: ${fromBlock} to ${endBlock}`);
  console.log(`Total blocks to scan: ${endBlock - fromBlock}\n`);

  const missedSales: MissedSale[] = [];
  const foundInDb: string[] = [];
  const batchSize = 10000n;

  let currentFrom = fromBlock;
  let totalEvents = 0;
  let wrapperEvents = 0;

  while (currentFrom < endBlock) {
    const currentTo = currentFrom + batchSize > endBlock ? endBlock : currentFrom + batchSize;

    process.stdout.write(`\rScanning blocks ${currentFrom} to ${currentTo}...`);

    try {
      const logs = await client.getLogs({
        address: SEAPORT_ADDRESS as `0x${string}`,
        event: SEAPORT_ABI[0],
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      totalEvents += logs.length;

      for (const log of logs) {
        const { orderHash, offerer, recipient, offer, consideration } = log.args as any;

        // Check if any offer item is from the Name Wrapper
        const wrapperItem = offer?.find((item: any) =>
          item.token?.toLowerCase() === NAME_WRAPPER_ADDRESS
        );

        if (wrapperItem) {
          wrapperEvents++;
          const tokenId = wrapperItem.identifier.toString();

          // Extract price from consideration (first item is usually the payment)
          const priceWei = consideration?.[0]?.amount?.toString() || '0';
          const currencyAddress = consideration?.[0]?.token?.toLowerCase() || '0x0000000000000000000000000000000000000000';

          // Check if this sale exists in our database
          const result = await pool.query(
            'SELECT id FROM sales WHERE transaction_hash = $1 OR order_hash = $2 LIMIT 1',
            [log.transactionHash, orderHash]
          );

          if (result.rows.length === 0) {
            missedSales.push({
              transactionHash: log.transactionHash!,
              blockNumber: log.blockNumber!,
              orderHash,
              offerer,
              recipient,
              tokenId,
              priceWei,
              currencyAddress,
            });
          } else {
            foundInDb.push(log.transactionHash!);
          }
        }
      }
    } catch (error: any) {
      console.error(`\nError scanning blocks ${currentFrom}-${currentTo}:`, error.message);
    }

    currentFrom = currentTo + 1n;
  }

  console.log('\n\n=== RESULTS ===\n');
  console.log(`Total OrderFulfilled events scanned: ${totalEvents}`);
  console.log(`Events involving Name Wrapper: ${wrapperEvents}`);
  console.log(`Already in database: ${foundInDb.length}`);
  console.log(`MISSED SALES: ${missedSales.length}`);

  if (missedSales.length > 0) {
    // Fetch timestamps for all missed sales
    console.log('\nFetching block timestamps...');
    for (let i = 0; i < missedSales.length; i++) {
      const sale = missedSales[i];
      try {
        const block = await client.getBlock({ blockNumber: sale.blockNumber });
        sale.timestamp = new Date(Number(block.timestamp) * 1000);
      } catch {
        // Ignore timestamp errors
      }
      if ((i + 1) % 10 === 0) {
        process.stdout.write(`\r  ${i + 1}/${missedSales.length} timestamps fetched`);
      }
    }
    console.log(`\n  Done fetching timestamps`);

    // Prepare JSON output
    const jsonOutput = missedSales.map(s => ({
      transactionHash: s.transactionHash,
      blockNumber: s.blockNumber.toString(),
      orderHash: s.orderHash,
      offerer: s.offerer,
      recipient: s.recipient,
      tokenId: s.tokenId,
      priceWei: s.priceWei,
      currencyAddress: s.currencyAddress,
      timestamp: s.timestamp?.toISOString(),
    }));

    if (outputFile) {
      // Write to file
      writeFileSync(outputFile, JSON.stringify(jsonOutput, null, 2));
      console.log(`\nWrote ${missedSales.length} missed sales to ${outputFile}`);
    } else {
      // Log to console if no output file specified
      console.log('\n=== MISSED SALES DETAILS ===\n');

      for (const sale of missedSales.slice(0, 20)) {
        console.log(`TX: ${sale.transactionHash}`);
        console.log(`  Block: ${sale.blockNumber}`);
        console.log(`  Date: ${sale.timestamp?.toISOString() || 'unknown'}`);
        console.log(`  Order Hash: ${sale.orderHash}`);
        console.log(`  Seller: ${sale.offerer}`);
        console.log(`  Buyer: ${sale.recipient}`);
        console.log(`  Token ID (namehash): ${sale.tokenId}`);
        console.log(`  Price: ${sale.priceWei} wei`);
        console.log(`  Etherscan: https://etherscan.io/tx/${sale.transactionHash}`);
        console.log('');
      }

      if (missedSales.length > 20) {
        console.log(`... and ${missedSales.length - 20} more\n`);
      }

      console.log('\nTip: Use --output <filename.json> to save results to a file');
    }
  }

  await pool.end();
}

findMissedSales()
  .then(() => {
    console.log('\nScript completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
