#!/usr/bin/env tsx

/**
 * Tally Renewal Referrals for Promotion
 *
 * This script fetches RenewalReferred events from the ENS Bulk Renewal contract
 * to tally entries for our $1000 promotion. Users get 1 "ticket" for each year
 * of duration they renew for through our referral code.
 *
 * Contract addresses:
 * - Bulk Renewal Contract: 0xafc5a354a159dc900bb9ea1082d3e20a3cd65026
 * - Event Emitter Contract: 0xf55575bde5953ee4272d5ce7cdd924c74d8fa81a
 * - Our Referral Code: 0x0000000000000000000000007E491CDE0FBF08E51F54C4FB6B9E24AFBD18966D
 *
 * Usage:
 *   npx tsx services/wal-listener/src/scripts/tally-renewal-referrals.ts [options]
 *
 * Options:
 *   --from-block N     Start from block number (default: contract deployment)
 *   --to-block N       End at block number (default: latest)
 *   --output-dir DIR   Output directory for CSV files (default: current directory)
 */

import { createPublicClient, http, parseAbiItem, formatEther } from 'viem';
import { mainnet } from 'viem/chains';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../shared/src';

// Contract addresses
const EVENT_EMITTER_CONTRACT = '0xf55575bde5953ee4272d5ce7cdd924c74d8fa81a' as const;
const OUR_REFERRAL_CODE = '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d' as const;

// RenewalReferred event ABI
const RENEWAL_REFERRED_EVENT = parseAbiItem(
  'event RenewalReferred(string label, bytes32 indexed labelHash, uint256 cost, uint256 duration, bytes32 referrer)'
);

// Constants
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60; // 31,536,000 seconds

interface RenewalEvent {
  transactionHash: string;
  blockNumber: bigint;
  userAddress: string;
  label: string;
  labelHash: string;
  cost: bigint;
  duration: bigint;
  referrer: string;
  timestamp?: number;
}

interface UserTally {
  address: string;
  totalDurationSeconds: bigint;
  totalDurationYears: number;
  tickets: number;
  totalCostWei: bigint;
  totalCostEth: string;
  renewalCount: number;
  names: string[];
}

async function fetchRenewalEvents(
  client: ReturnType<typeof createPublicClient>,
  fromBlock: bigint,
  toBlock: bigint
): Promise<RenewalEvent[]> {
  const events: RenewalEvent[] = [];
  const BATCH_SIZE = 10000n;

  console.log(`\nFetching RenewalReferred events from block ${fromBlock} to ${toBlock}...`);
  console.log(`Filtering by referrer: ${OUR_REFERRAL_CODE}\n`);

  let currentBlock = fromBlock;
  let batchNum = 0;

  while (currentBlock <= toBlock) {
    const endBlock = currentBlock + BATCH_SIZE > toBlock ? toBlock : currentBlock + BATCH_SIZE;
    batchNum++;

    console.log(`  Batch ${batchNum}: blocks ${currentBlock} - ${endBlock}...`);

    try {
      const logs = await client.getLogs({
        address: EVENT_EMITTER_CONTRACT,
        event: RENEWAL_REFERRED_EVENT,
        fromBlock: currentBlock,
        toBlock: endBlock,
      });

      // Filter by our referral code and get transaction details
      for (const log of logs) {
        const referrer = log.args.referrer?.toLowerCase();

        if (referrer === OUR_REFERRAL_CODE.toLowerCase()) {
          // Get the transaction to find the sender
          const tx = await client.getTransaction({
            hash: log.transactionHash,
          });

          events.push({
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
            userAddress: tx.from.toLowerCase(),
            label: log.args.label || '',
            labelHash: log.args.labelHash || '',
            cost: log.args.cost || 0n,
            duration: log.args.duration || 0n,
            referrer: referrer,
          });
        }
      }

      console.log(`    Found ${logs.length} total events, ${events.length} with our referral code so far`);
    } catch (error: any) {
      console.error(`    Error fetching batch: ${error.message}`);
      // Retry with smaller batch on failure
      if (BATCH_SIZE > 1000n) {
        console.log('    Retrying with smaller batch...');
        const smallerBatch = 1000n;
        let retryBlock = currentBlock;
        while (retryBlock <= endBlock) {
          const retryEnd = retryBlock + smallerBatch > endBlock ? endBlock : retryBlock + smallerBatch;
          try {
            const logs = await client.getLogs({
              address: EVENT_EMITTER_CONTRACT,
              event: RENEWAL_REFERRED_EVENT,
              fromBlock: retryBlock,
              toBlock: retryEnd,
            });

            for (const log of logs) {
              const referrer = log.args.referrer?.toLowerCase();
              if (referrer === OUR_REFERRAL_CODE.toLowerCase()) {
                const tx = await client.getTransaction({ hash: log.transactionHash });
                events.push({
                  transactionHash: log.transactionHash,
                  blockNumber: log.blockNumber,
                  userAddress: tx.from.toLowerCase(),
                  label: log.args.label || '',
                  labelHash: log.args.labelHash || '',
                  cost: log.args.cost || 0n,
                  duration: log.args.duration || 0n,
                  referrer: referrer,
                });
              }
            }
          } catch (retryError: any) {
            console.error(`    Retry error at block ${retryBlock}: ${retryError.message}`);
          }
          retryBlock = retryEnd + 1n;
        }
      }
    }

    currentBlock = endBlock + 1n;

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return events;
}

async function getBlockTimestamps(
  client: ReturnType<typeof createPublicClient>,
  events: RenewalEvent[]
): Promise<Map<bigint, number>> {
  const blockNumbers = [...new Set(events.map((e) => e.blockNumber))];
  const timestamps = new Map<bigint, number>();

  console.log(`\nFetching timestamps for ${blockNumbers.length} unique blocks...`);

  for (let i = 0; i < blockNumbers.length; i += 10) {
    const batch = blockNumbers.slice(i, i + 10);
    await Promise.all(
      batch.map(async (blockNumber) => {
        try {
          const block = await client.getBlock({ blockNumber });
          timestamps.set(blockNumber, Number(block.timestamp));
        } catch (error) {
          console.error(`  Failed to get timestamp for block ${blockNumber}`);
        }
      })
    );

    if ((i + 10) % 100 === 0) {
      console.log(`  Processed ${Math.min(i + 10, blockNumbers.length)}/${blockNumbers.length} blocks`);
    }
  }

  return timestamps;
}

function tallyByUser(events: RenewalEvent[]): Map<string, UserTally> {
  const tallies = new Map<string, UserTally>();

  for (const event of events) {
    const existing = tallies.get(event.userAddress);

    if (existing) {
      existing.totalDurationSeconds += event.duration;
      existing.totalCostWei += event.cost;
      existing.renewalCount++;
      if (!existing.names.includes(event.label)) {
        existing.names.push(event.label);
      }
    } else {
      tallies.set(event.userAddress, {
        address: event.userAddress,
        totalDurationSeconds: event.duration,
        totalDurationYears: 0, // Calculate after
        tickets: 0, // Calculate after
        totalCostWei: event.cost,
        totalCostEth: '', // Calculate after
        renewalCount: 1,
        names: [event.label],
      });
    }
  }

  // Calculate years and tickets
  for (const tally of tallies.values()) {
    const durationSeconds = Number(tally.totalDurationSeconds);
    tally.totalDurationYears = durationSeconds / SECONDS_PER_YEAR;
    tally.tickets = Math.floor(tally.totalDurationYears); // 1 ticket per full year
    tally.totalCostEth = formatEther(tally.totalCostWei);
  }

  return tallies;
}

function formatDuration(seconds: bigint): string {
  const totalSeconds = Number(seconds);
  const years = Math.floor(totalSeconds / SECONDS_PER_YEAR);
  const remainingSeconds = totalSeconds % SECONDS_PER_YEAR;
  const months = Math.floor(remainingSeconds / (30 * 24 * 60 * 60));
  const days = Math.floor((remainingSeconds % (30 * 24 * 60 * 60)) / (24 * 60 * 60));

  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}m`);
  if (days > 0) parts.push(`${days}d`);

  return parts.join(' ') || '0d';
}

function writeDetailedCsv(events: RenewalEvent[], timestamps: Map<bigint, number>, outputPath: string): void {
  const header = 'transaction_hash,block_number,timestamp,user_address,label,duration_seconds,duration_formatted,cost_wei,cost_eth\n';

  const rows = events.map((event) => {
    const timestamp = timestamps.get(event.blockNumber);
    const date = timestamp ? new Date(timestamp * 1000).toISOString() : '';

    return [
      event.transactionHash,
      event.blockNumber.toString(),
      date,
      event.userAddress,
      `"${event.label}.eth"`,
      event.duration.toString(),
      formatDuration(event.duration),
      event.cost.toString(),
      formatEther(event.cost),
    ].join(',');
  });

  fs.writeFileSync(outputPath, header + rows.join('\n'));
  console.log(`\nDetailed events CSV written to: ${outputPath}`);
}

function writeSummaryCsv(tallies: Map<string, UserTally>, outputPath: string): void {
  const header = 'rank,user_address,tickets,total_duration_years,total_duration_formatted,renewal_count,total_cost_eth,names_renewed\n';

  // Sort by tickets (descending), then by total duration
  const sorted = [...tallies.values()].sort((a, b) => {
    if (b.tickets !== a.tickets) return b.tickets - a.tickets;
    return Number(b.totalDurationSeconds - a.totalDurationSeconds);
  });

  const rows = sorted.map((tally, index) => {
    return [
      index + 1,
      tally.address,
      tally.tickets,
      tally.totalDurationYears.toFixed(2),
      formatDuration(tally.totalDurationSeconds),
      tally.renewalCount,
      tally.totalCostEth,
      `"${tally.names.slice(0, 10).join(', ')}${tally.names.length > 10 ? '...' : ''}"`,
    ].join(',');
  });

  fs.writeFileSync(outputPath, header + rows.join('\n'));
  console.log(`Summary CSV written to: ${outputPath}`);
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let fromBlock: bigint | undefined;
  let toBlock: bigint | 'latest' = 'latest';
  let outputDir = '.';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-block' && args[i + 1]) {
      fromBlock = BigInt(args[i + 1]);
      i++;
    } else if (args[i] === '--to-block' && args[i + 1]) {
      toBlock = args[i + 1] === 'latest' ? 'latest' : BigInt(args[i + 1]);
      i++;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    }
  }

  console.log('='.repeat(60));
  console.log('Renewal Referral Tally Script');
  console.log('='.repeat(60));
  console.log(`\nEvent Emitter Contract: ${EVENT_EMITTER_CONTRACT}`);
  console.log(`Our Referral Code: ${OUR_REFERRAL_CODE}`);
  console.log(`Output Directory: ${outputDir}`);

  // Create viem client
  const rpcUrl = config.blockchain.rpcUrl;
  if (!rpcUrl) {
    console.error('\nError: RPC_URL environment variable is not set');
    process.exit(1);
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  // Get current block number
  const latestBlock = await client.getBlockNumber();
  console.log(`\nLatest block: ${latestBlock}`);

  // Default from block - approximate deployment block of the contract
  // You may want to adjust this based on when your promotion started
  if (!fromBlock) {
    fromBlock = 23784200n; // Approximate - adjust as needed
    console.log(`Using default from-block: ${fromBlock}`);
  }

  const endBlock = toBlock === 'latest' ? latestBlock : toBlock;
  console.log(`Scanning blocks: ${fromBlock} to ${endBlock}`);

  // Fetch events
  const events = await fetchRenewalEvents(client, fromBlock, endBlock);

  if (events.length === 0) {
    console.log('\nNo renewal events found with our referral code.');
    return;
  }

  console.log(`\nTotal events found: ${events.length}`);

  // Get timestamps for events
  const timestamps = await getBlockTimestamps(client, events);

  // Tally by user
  const tallies = tallyByUser(events);

  console.log(`\nUnique users: ${tallies.size}`);

  // Calculate total tickets
  let totalTickets = 0;
  for (const tally of tallies.values()) {
    totalTickets += tally.tickets;
  }
  console.log(`Total tickets issued: ${totalTickets}`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate output files
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const detailedPath = path.join(outputDir, `renewal-referrals-detailed-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `renewal-referrals-summary-${timestamp}.csv`);

  writeDetailedCsv(events, timestamps, detailedPath);
  writeSummaryCsv(tallies, summaryPath);

  // Print top 10 summary
  console.log('\n' + '='.repeat(60));
  console.log('TOP ENTRANTS (by tickets)');
  console.log('='.repeat(60));
  console.log('');

  const sorted = [...tallies.values()].sort((a, b) => {
    if (b.tickets !== a.tickets) return b.tickets - a.tickets;
    return Number(b.totalDurationSeconds - a.totalDurationSeconds);
  });

  console.log('Rank | Address                                      | Tickets | Duration   | Renewals');
  console.log('-'.repeat(100));

  sorted.slice(0, 10).forEach((tally, index) => {
    console.log(
      `${(index + 1).toString().padStart(4)} | ${tally.address} | ${tally.tickets.toString().padStart(7)} | ${formatDuration(tally.totalDurationSeconds).padStart(10)} | ${tally.renewalCount.toString().padStart(8)}`
    );
  });

  if (sorted.length > 10) {
    console.log(`\n... and ${sorted.length - 10} more users`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('PROMOTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Users: ${tallies.size}`);
  console.log(`Total Renewals: ${events.length}`);
  console.log(`Total Tickets: ${totalTickets}`);

  // Top 3 winners
  console.log('\nTop 3 Winners ($1000 prize pool):');
  sorted.slice(0, 3).forEach((tally, index) => {
    const prize = index === 0 ? '$500' : index === 1 ? '$300' : '$200';
    console.log(`  ${index + 1}. ${tally.address}`);
    console.log(`     Tickets: ${tally.tickets} | Duration: ${formatDuration(tally.totalDurationSeconds)} | Prize: ${prize}`);
  });

  console.log('\nDone!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
