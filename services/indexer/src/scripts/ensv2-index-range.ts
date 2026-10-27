/**
 * Index an ENSv2 block range through EnsV2Indexer's handlers, without moving the indexer's
 * cursor. Handlers are idempotent per event, but replaying an old range re-applies that
 * range's state (e.g. a registration's expiry over a later renewal), so always index from
 * the start of the range through to the indexer's cursor (or the chain head).
 *
 * Usage: node dist/indexer/src/scripts/ensv2-index-range.js --chain <chainId> <fromBlock> [toBlock]
 *
 * --chain must match the loaded config's CHAIN_ID, so the script can't run against the
 * wrong environment's database (e.g. a local mainnet .env). It prints the target chain and
 * database host before writing anything.
 */

import { config, closeAllConnections } from '../../../shared/src';
import { EnsV2Indexer } from '../indexers/ensv2-indexer';
import { closeQueueClient } from '../queue';

const CHUNK = 500n;
const USAGE = 'Usage: ensv2-index-range --chain <chainId> <fromBlock> [toBlock]';

function databaseHost(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const chainFlag = args.indexOf('--chain');
  const expectedChain = chainFlag >= 0 ? args[chainFlag + 1] : undefined;
  if (chainFlag >= 0) args.splice(chainFlag, 2);
  const [fromArg, toArg] = args;

  if (!expectedChain || !fromArg) {
    console.error(USAGE);
    process.exit(1);
  }
  if (Number(expectedChain) !== config.blockchain.chainId) {
    console.error(
      `Refusing to run: --chain ${expectedChain} but the loaded config is chain ` +
        `${config.blockchain.chainId} (database ${databaseHost(config.database.url)}). ` +
        'Check which environment variables / .env this shell is using.'
    );
    process.exit(1);
  }
  console.log(
    `Target: chain ${config.blockchain.chainId}, database ${databaseHost(config.database.url)}`
  );
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
