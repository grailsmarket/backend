#!/usr/bin/env tsx

/**
 * Tally Referrals (Renewals + Registrations) for Promotion
 *
 * Fetches three event streams keyed to our referrer code, combines them into
 * a single per-user tally, and emits one detailed CSV + one summary CSV.
 *
 *   - RenewalReferred from the bulk renewal Event Emitter (existing path)
 *   - NameRegistered from the ETH Registrar Controller 2 (new)
 *   - NameRenewed   from the ETH Registrar Controller 2 (new, single-name renewals)
 *
 * Tickets = floor(totalDurationYears) per user. For controller events, duration
 * is computed as (expires - blockTimestamp). This is exact for registrations and
 * an over-count for controller renewals when the prior expiry was still in the
 * future — accepted trade-off for this promotion.
 *
 * Usage:
 *   cd services/wal-listener && npm run build
 *   node dist/wal-listener/src/scripts/tally-referrals.js [options]
 *
 * Options:
 *   --from-block N     Start from block number (default: 23784200)
 *   --to-block N       End at block number (default: latest)
 *   --output-dir DIR   Output directory for CSV files (default: current directory)
 */

import { createPublicClient, http, parseAbiItem, formatEther } from 'viem';
import { mainnet } from 'viem/chains';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../shared/src';

const BULK_RENEWAL_EMITTER = '0xf55575bde5953ee4272d5ce7cdd924c74d8fa81a' as const;
const ETH_REGISTRAR_CONTROLLER_2 = '0x59e16fccd424cc24e280be16e11bcd56fb0ce547' as const;
const OUR_REFERRAL_CODE = '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d' as const;

const RENEWAL_REFERRED_EVENT = parseAbiItem(
  'event RenewalReferred(string label, bytes32 indexed labelHash, uint256 cost, uint256 duration, bytes32 referrer)'
);
const NAME_REGISTERED_EVENT = parseAbiItem(
  'event NameRegistered(string label, bytes32 indexed labelhash, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires, bytes32 referrer)'
);
const NAME_RENEWED_EVENT = parseAbiItem(
  'event NameRenewed(string label, bytes32 indexed labelhash, uint256 cost, uint256 expires, bytes32 referrer)'
);

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const BATCH_SIZE = 10000n;
const RETRY_BATCH_SIZE = 1000n;

type EventType = 'bulk_renewal' | 'register' | 'controller_renew';

interface ReferralEvent {
  eventType: EventType;
  transactionHash: string;
  blockNumber: bigint;
  blockTimestamp?: number;
  userAddress: string;
  label: string;
  labelHash: string;
  cost: bigint;
  duration: bigint; // Set after blockTimestamp is known for controller events.
  expires?: bigint; // Only present for controller events; used to compute duration.
}

interface UserTally {
  address: string;
  totalDurationSeconds: bigint;
  totalDurationYears: number;
  tickets: number;
  totalCostWei: bigint;
  totalCostEth: string;
  renewalCount: number; // RenewalReferred + controller_renew
  registerCount: number;
  names: string[];
}

type Client = ReturnType<typeof createPublicClient>;

async function fetchInBatches<T>(
  fromBlock: bigint,
  toBlock: bigint,
  label: string,
  fetchOne: (start: bigint, end: bigint) => Promise<T[]>
): Promise<T[]> {
  const results: T[] = [];
  let current = fromBlock;
  let batchNum = 0;

  while (current <= toBlock) {
    const end = current + BATCH_SIZE > toBlock ? toBlock : current + BATCH_SIZE;
    batchNum++;
    console.log(`  [${label}] Batch ${batchNum}: blocks ${current} - ${end}...`);

    try {
      const found = await fetchOne(current, end);
      results.push(...found);
      console.log(`    -> ${found.length} matching events (total so far: ${results.length})`);
    } catch (error: any) {
      console.error(`    Error fetching batch: ${error.message}`);
      console.log('    Retrying with smaller batch...');
      let retry = current;
      while (retry <= end) {
        const retryEnd = retry + RETRY_BATCH_SIZE > end ? end : retry + RETRY_BATCH_SIZE;
        try {
          const found = await fetchOne(retry, retryEnd);
          results.push(...found);
        } catch (retryError: any) {
          console.error(`    Retry error at block ${retry}: ${retryError.message}`);
        }
        retry = retryEnd + 1n;
      }
    }

    current = end + 1n;
    await new Promise((r) => setTimeout(r, 100));
  }

  return results;
}

async function fetchBulkRenewalEvents(client: Client, fromBlock: bigint, toBlock: bigint): Promise<ReferralEvent[]> {
  console.log(`\nFetching RenewalReferred events from ${BULK_RENEWAL_EMITTER}...`);
  return fetchInBatches(fromBlock, toBlock, 'bulk_renewal', async (start, end) => {
    const logs = await client.getLogs({
      address: BULK_RENEWAL_EMITTER,
      event: RENEWAL_REFERRED_EVENT,
      fromBlock: start,
      toBlock: end,
    });

    const matched: ReferralEvent[] = [];
    for (const log of logs) {
      if (log.args.referrer?.toLowerCase() !== OUR_REFERRAL_CODE.toLowerCase()) continue;
      const tx = await client.getTransaction({ hash: log.transactionHash });
      matched.push({
        eventType: 'bulk_renewal',
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        userAddress: tx.from.toLowerCase(),
        label: log.args.label || '',
        labelHash: log.args.labelHash || '',
        cost: log.args.cost || 0n,
        duration: log.args.duration || 0n,
      });
    }
    return matched;
  });
}

async function fetchRegistrationEvents(client: Client, fromBlock: bigint, toBlock: bigint): Promise<ReferralEvent[]> {
  console.log(`\nFetching NameRegistered events from ${ETH_REGISTRAR_CONTROLLER_2}...`);
  return fetchInBatches(fromBlock, toBlock, 'register', async (start, end) => {
    const logs = await client.getLogs({
      address: ETH_REGISTRAR_CONTROLLER_2,
      event: NAME_REGISTERED_EVENT,
      fromBlock: start,
      toBlock: end,
    });

    const matched: ReferralEvent[] = [];
    for (const log of logs) {
      if (log.args.referrer?.toLowerCase() !== OUR_REFERRAL_CODE.toLowerCase()) continue;
      const tx = await client.getTransaction({ hash: log.transactionHash });
      const baseCost = log.args.baseCost || 0n;
      const premium = log.args.premium || 0n;
      matched.push({
        eventType: 'register',
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        userAddress: tx.from.toLowerCase(),
        label: log.args.label || '',
        labelHash: log.args.labelhash || '',
        cost: baseCost + premium,
        duration: 0n, // Filled in after timestamps are fetched.
        expires: log.args.expires || 0n,
      });
    }
    return matched;
  });
}

async function fetchControllerRenewalEvents(client: Client, fromBlock: bigint, toBlock: bigint): Promise<ReferralEvent[]> {
  console.log(`\nFetching NameRenewed events from ${ETH_REGISTRAR_CONTROLLER_2}...`);
  return fetchInBatches(fromBlock, toBlock, 'controller_renew', async (start, end) => {
    const logs = await client.getLogs({
      address: ETH_REGISTRAR_CONTROLLER_2,
      event: NAME_RENEWED_EVENT,
      fromBlock: start,
      toBlock: end,
    });

    const matched: ReferralEvent[] = [];
    for (const log of logs) {
      if (log.args.referrer?.toLowerCase() !== OUR_REFERRAL_CODE.toLowerCase()) continue;
      const tx = await client.getTransaction({ hash: log.transactionHash });
      matched.push({
        eventType: 'controller_renew',
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        userAddress: tx.from.toLowerCase(),
        label: log.args.label || '',
        labelHash: log.args.labelhash || '',
        cost: log.args.cost || 0n,
        duration: 0n, // Filled in after timestamps are fetched.
        expires: log.args.expires || 0n,
      });
    }
    return matched;
  });
}

async function getBlockTimestamps(client: Client, events: ReferralEvent[]): Promise<Map<bigint, number>> {
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
        } catch {
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

function fillControllerDurations(events: ReferralEvent[], timestamps: Map<bigint, number>): void {
  for (const event of events) {
    const ts = timestamps.get(event.blockNumber);
    if (ts !== undefined) event.blockTimestamp = ts;

    if (event.eventType === 'bulk_renewal') continue;
    if (event.expires === undefined || ts === undefined) {
      event.duration = 0n;
      continue;
    }
    const computed = event.expires - BigInt(ts);
    event.duration = computed > 0n ? computed : 0n;
  }
}

function tallyByUser(events: ReferralEvent[]): Map<string, UserTally> {
  const tallies = new Map<string, UserTally>();

  for (const event of events) {
    const isRegister = event.eventType === 'register';
    const tally = tallies.get(event.userAddress);

    if (tally) {
      tally.totalDurationSeconds += event.duration;
      tally.totalCostWei += event.cost;
      if (isRegister) tally.registerCount++;
      else tally.renewalCount++;
      if (!tally.names.includes(event.label)) tally.names.push(event.label);
    } else {
      tallies.set(event.userAddress, {
        address: event.userAddress,
        totalDurationSeconds: event.duration,
        totalDurationYears: 0,
        tickets: 0,
        totalCostWei: event.cost,
        totalCostEth: '',
        renewalCount: isRegister ? 0 : 1,
        registerCount: isRegister ? 1 : 0,
        names: [event.label],
      });
    }
  }

  for (const tally of tallies.values()) {
    const seconds = Number(tally.totalDurationSeconds);
    tally.totalDurationYears = seconds / SECONDS_PER_YEAR;
    tally.tickets = Math.floor(tally.totalDurationYears);
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

function writeDetailedCsv(events: ReferralEvent[], outputPath: string): void {
  const header =
    'event_type,transaction_hash,block_number,timestamp,user_address,label,duration_seconds,duration_formatted,cost_wei,cost_eth\n';

  const rows = events.map((event) => {
    const date = event.blockTimestamp ? new Date(event.blockTimestamp * 1000).toISOString() : '';
    return [
      event.eventType,
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
  const header =
    'rank,user_address,tickets,total_duration_years,total_duration_formatted,renewal_count,register_count,total_cost_eth,names\n';

  const sorted = [...tallies.values()].sort((a, b) => {
    if (b.tickets !== a.tickets) return b.tickets - a.tickets;
    return Number(b.totalDurationSeconds - a.totalDurationSeconds);
  });

  const rows = sorted.map((tally, index) =>
    [
      index + 1,
      tally.address,
      tally.tickets,
      tally.totalDurationYears.toFixed(2),
      formatDuration(tally.totalDurationSeconds),
      tally.renewalCount,
      tally.registerCount,
      tally.totalCostEth,
      `"${tally.names.slice(0, 10).join(', ')}${tally.names.length > 10 ? '...' : ''}"`,
    ].join(',')
  );

  fs.writeFileSync(outputPath, header + rows.join('\n'));
  console.log(`Summary CSV written to: ${outputPath}`);
}

async function main() {
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
  console.log('Combined Referral Tally Script (renewals + registrations)');
  console.log('='.repeat(60));
  console.log(`\nBulk Renewal Emitter:    ${BULK_RENEWAL_EMITTER}`);
  console.log(`Registrar Controller 2:  ${ETH_REGISTRAR_CONTROLLER_2}`);
  console.log(`Our Referral Code:       ${OUR_REFERRAL_CODE}`);
  console.log(`Output Directory:        ${outputDir}`);

  const rpcUrl = config.blockchain.rpcUrl;
  if (!rpcUrl) {
    console.error('\nError: RPC_URL environment variable is not set');
    process.exit(1);
  }

  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const latestBlock = await client.getBlockNumber();
  console.log(`\nLatest block: ${latestBlock}`);

  if (!fromBlock) {
    fromBlock = 23784200n;
    console.log(`Using default from-block: ${fromBlock}`);
  }
  const endBlock = toBlock === 'latest' ? latestBlock : toBlock;
  console.log(`Scanning blocks: ${fromBlock} to ${endBlock}`);

  const bulkRenewalEvents = await fetchBulkRenewalEvents(client, fromBlock, endBlock);
  const registrationEvents = await fetchRegistrationEvents(client, fromBlock, endBlock);
  const controllerRenewalEvents = await fetchControllerRenewalEvents(client, fromBlock, endBlock);

  const allEvents: ReferralEvent[] = [
    ...bulkRenewalEvents,
    ...registrationEvents,
    ...controllerRenewalEvents,
  ];

  console.log('\n' + '='.repeat(60));
  console.log(`Bulk RenewalReferred events:        ${bulkRenewalEvents.length}`);
  console.log(`Controller NameRegistered events:   ${registrationEvents.length}`);
  console.log(`Controller NameRenewed events:      ${controllerRenewalEvents.length}`);
  console.log(`Total events: ${allEvents.length}`);
  console.log('='.repeat(60));

  if (allEvents.length === 0) {
    console.log('\nNo referred events found.');
    return;
  }

  const timestamps = await getBlockTimestamps(client, allEvents);
  fillControllerDurations(allEvents, timestamps);

  // Sort events chronologically for the detailed CSV.
  allEvents.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.transactionHash.localeCompare(b.transactionHash);
  });

  const tallies = tallyByUser(allEvents);
  console.log(`\nUnique users: ${tallies.size}`);

  let totalTickets = 0;
  for (const tally of tallies.values()) totalTickets += tally.tickets;
  console.log(`Total tickets issued: ${totalTickets}`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const detailedPath = path.join(outputDir, `referrals-detailed-${ts}.csv`);
  const summaryPath = path.join(outputDir, `referrals-summary-${ts}.csv`);

  writeDetailedCsv(allEvents, detailedPath);
  writeSummaryCsv(tallies, summaryPath);

  console.log('\n' + '='.repeat(60));
  console.log('TOP ENTRANTS (by tickets)');
  console.log('='.repeat(60));
  console.log('');

  const sorted = [...tallies.values()].sort((a, b) => {
    if (b.tickets !== a.tickets) return b.tickets - a.tickets;
    return Number(b.totalDurationSeconds - a.totalDurationSeconds);
  });

  console.log('Rank | Address                                      | Tickets | Duration   | Renewals | Regs');
  console.log('-'.repeat(108));
  sorted.slice(0, 10).forEach((tally, index) => {
    console.log(
      `${(index + 1).toString().padStart(4)} | ${tally.address} | ${tally.tickets.toString().padStart(7)} | ${formatDuration(
        tally.totalDurationSeconds
      ).padStart(10)} | ${tally.renewalCount.toString().padStart(8)} | ${tally.registerCount.toString().padStart(4)}`
    );
  });
  if (sorted.length > 10) console.log(`\n... and ${sorted.length - 10} more users`);

  console.log('\n' + '='.repeat(60));
  console.log('PROMOTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Users:    ${tallies.size}`);
  console.log(`Total Renewals: ${bulkRenewalEvents.length + controllerRenewalEvents.length} (bulk: ${bulkRenewalEvents.length}, controller: ${controllerRenewalEvents.length})`);
  console.log(`Total Regs:     ${registrationEvents.length}`);
  console.log(`Total Tickets:  ${totalTickets}`);

  console.log('\nNote: NameRenewed duration uses (expires - blockTimestamp), which over-counts');
  console.log('when the prior expiry was still in the future. NameRegistered is exact.');

  console.log('\nDone!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
