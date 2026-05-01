#!/usr/bin/env tsx

/**
 * Quick one-off: count NameRenewed events on the ETH Registrar Controller 2
 * (single-name renewals through the controller, NOT bulk renewals) that used
 * our referrer code over the same default block range as the tally script.
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { config } from '../../../shared/src';

const ETH_REGISTRAR_CONTROLLER_2 = '0x59e16fccd424cc24e280be16e11bcd56fb0ce547' as const;
const OUR_REFERRAL_CODE = '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d' as const;

const NAME_RENEWED_EVENT = parseAbiItem(
  'event NameRenewed(string label, bytes32 indexed labelhash, uint256 cost, uint256 expires, bytes32 referrer)'
);

const BATCH_SIZE = 10000n;

async function main() {
  const args = process.argv.slice(2);
  let fromBlock: bigint = 23784200n;
  let toBlock: bigint | 'latest' = 'latest';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-block' && args[i + 1]) {
      fromBlock = BigInt(args[i + 1]);
      i++;
    } else if (args[i] === '--to-block' && args[i + 1]) {
      toBlock = args[i + 1] === 'latest' ? 'latest' : BigInt(args[i + 1]);
      i++;
    }
  }

  const rpcUrl = config.blockchain.rpcUrl;
  if (!rpcUrl) {
    console.error('RPC_URL not set');
    process.exit(1);
  }

  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const latest = await client.getBlockNumber();
  const endBlock = toBlock === 'latest' ? latest : toBlock;

  console.log(`Counting NameRenewed events on ${ETH_REGISTRAR_CONTROLLER_2}`);
  console.log(`Filter: referrer == ${OUR_REFERRAL_CODE}`);
  console.log(`Range:  ${fromBlock} - ${endBlock}\n`);

  let totalLogs = 0;
  let matched = 0;
  const sampleHashes: string[] = [];
  const userAddresses = new Set<string>();

  let current = fromBlock;
  while (current <= endBlock) {
    const end = current + BATCH_SIZE > endBlock ? endBlock : current + BATCH_SIZE;
    process.stdout.write(`  blocks ${current} - ${end} ... `);

    try {
      const logs = await client.getLogs({
        address: ETH_REGISTRAR_CONTROLLER_2,
        event: NAME_RENEWED_EVENT,
        fromBlock: current,
        toBlock: end,
      });
      totalLogs += logs.length;

      for (const log of logs) {
        if (log.args.referrer?.toLowerCase() === OUR_REFERRAL_CODE.toLowerCase()) {
          matched++;
          if (sampleHashes.length < 5) sampleHashes.push(log.transactionHash);
          // Track unique senders (uses tx.from like the main tally script does).
          const tx = await client.getTransaction({ hash: log.transactionHash });
          userAddresses.add(tx.from.toLowerCase());
        }
      }
      console.log(`${logs.length} total, ${matched} matched so far`);
    } catch (e: any) {
      console.log(`error: ${e.message}`);
    }

    current = end + 1n;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total NameRenewed events seen on controller: ${totalLogs}`);
  console.log(`Matched with our referrer code:              ${matched}`);
  console.log(`Unique sender addresses:                     ${userAddresses.size}`);
  if (sampleHashes.length > 0) {
    console.log(`\nSample tx hashes:`);
    sampleHashes.forEach((h) => console.log(`  ${h}`));
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
