/**
 * Index an ENSv2 block range through EnsV2Indexer's handlers, without moving the indexer's
 * cursor. Handlers are idempotent per event, but replaying an old range re-applies that
 * range's state (e.g. a registration's expiry over a later renewal), so always index from
 * the start of the range through to the indexer's cursor (or the chain head).
 *
 * Usage: node dist/indexer/src/scripts/ensv2-index-range.js <fromBlock> [toBlock]
 */

import { config, closeAllConnections } from '../../../shared/src';
import { EnsV2Indexer } from '../indexers/ensv2-indexer';
import { closeQueueClient } from '../queue';

const CHUNK = 500n;

async function main() {
  const [fromArg, toArg] = process.argv.slice(2);
  if (!fromArg) {
    console.error('Usage: ensv2-index-range <fromBlock> [toBlock]');
    process.exit(1);
  }
  if (!config.blockchain.ensv2) {
    console.error(`ENSv2 is not configured for chain ${config.blockchain.chainId}`);
    process.exit(1);
  }

  const from = BigInt(fromArg);
  const to = BigInt(toArg ?? fromArg);
  const indexer = new EnsV2Indexer();

  for (let start = from; start <= to; start += CHUNK) {
    const end = start + CHUNK - 1n < to ? start + CHUNK - 1n : to;
    await indexer.indexBlockRange(start, end);
  }

  console.log(`Indexed ENSv2 blocks ${from}-${to}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueueClient();
    await closeAllConnections();
  });
