import { getPostgresPool, config } from '../../../shared/src';
import { createPublicClient, http, namehash, parseAbi, PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { keccak256, toHex } from 'viem';

/**
 * Script to detect wrapped ENS names with out-of-sync expiry dates
 *
 * OPTIMIZED VERSION:
 * - Filters database to only check names where owner_address = NameWrapper (already wrapped)
 * - Uses multicall to batch RPC calls (100+ calls per request)
 * - Processes batches concurrently
 *
 * A name is desynced when:
 * - NameWrapper.getData(namehash).expiry !== BaseRegistrar.nameExpires(labelhash) + GRACE_PERIOD
 *
 * This happens when a wrapped name is renewed through the old ETHRegistrarController
 * (unwrapped controller) instead of the NameWrapper-aware controller.
 *
 * Reference: https://github.com/ensdomains/ens-app-v3/pull/1107
 *
 * Usage:
 *   node dist/.../find-desynced-wrapped-names.js [--save] [--limit=N] [--verbose] [--name=example.eth]
 */

// Contract addresses
const BASE_REGISTRAR = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85' as const;
const NAME_WRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401' as const;

// Grace period: 90 days in seconds
const GRACE_PERIOD = 90n * 24n * 60n * 60n; // 7,776,000 seconds

// ABIs
const BASE_REGISTRAR_ABI = parseAbi([
  'function nameExpires(uint256 id) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const NAME_WRAPPER_ABI = parseAbi([
  'function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)',
]);

// CLI arguments
const DRY_RUN = !process.argv.includes('--save');
const VERBOSE = process.argv.includes('--verbose');

// Parse --limit argument
let LIMIT = 0;
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
if (limitArg) {
  LIMIT = parseInt(limitArg.split('=')[1]);
}

// Parse --name argument for checking a specific name
let SPECIFIC_NAME: string | null = null;
const nameArg = process.argv.find(arg => arg.startsWith('--name='));
if (nameArg) {
  SPECIFIC_NAME = nameArg.split('=')[1];
  if (!SPECIFIC_NAME.endsWith('.eth')) {
    SPECIFIC_NAME = SPECIFIC_NAME + '.eth';
  }
}

// Batch settings - OPTIMIZED
const MULTICALL_BATCH_SIZE = 200; // Names per multicall batch
const CONCURRENT_BATCHES = 3; // Number of concurrent multicall requests
const RPC_DELAY_MS = 50; // Small delay between batch groups

interface DesyncedName {
  id: number;
  name: string;
  tokenId: string;
  ownerAddress: string;
  registrarExpiry: bigint;
  wrapperExpiry: bigint;
  expectedWrapperExpiry: bigint;
  diffSeconds: bigint;
  diffDays: number;
  wrapperExpired: boolean; // true if wrapper thinks name is expired NOW
}

interface NameRecord {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
}

/**
 * Compute labelhash from label (e.g., "vitalik" -> labelhash)
 */
function computeLabelhash(label: string): bigint {
  const hash = keccak256(toHex(label));
  return BigInt(hash);
}

/**
 * Process a batch of names using multicall
 * Step 1: Check ownerOf on BaseRegistrar to find wrapped names
 * Step 2: For wrapped names, compare expiry dates
 */
async function processBatchWithMulticall(
  client: PublicClient,
  names: NameRecord[]
): Promise<{
  desynced: DesyncedName[];
  errors: number;
  wrapped: number;
  unwrapped: number;
}> {
  const desynced: DesyncedName[] = [];
  let errors = 0;
  let wrapped = 0;
  let unwrapped = 0;

  // Step 1: Check ownerOf for all names to find which are wrapped
  const ownerCalls = names.map(record => {
    const label = record.name.replace('.eth', '');
    const labelHash = computeLabelhash(label);
    return {
      address: BASE_REGISTRAR,
      abi: BASE_REGISTRAR_ABI,
      functionName: 'ownerOf' as const,
      args: [labelHash] as const,
    };
  });

  let ownerResults: any[];
  try {
    ownerResults = await client.multicall({ contracts: ownerCalls, allowFailure: true });
  } catch (error: any) {
    errors += names.length;
    if (VERBOSE) {
      console.error(`\nOwnerOf multicall failed: ${error.message}`);
    }
    return { desynced, errors, wrapped, unwrapped };
  }

  // Find which names are wrapped
  const wrappedNames: { record: NameRecord; labelHash: bigint }[] = [];
  for (let i = 0; i < names.length; i++) {
    const result = ownerResults[i];
    if (result.status === 'failure') {
      errors++;
      continue;
    }

    const owner = (result.result as string).toLowerCase();
    if (owner === NAME_WRAPPER.toLowerCase()) {
      const label = names[i].name.replace('.eth', '');
      wrappedNames.push({ record: names[i], labelHash: computeLabelhash(label) });
      wrapped++;
    } else {
      unwrapped++;
    }
  }

  // Step 2: For wrapped names, get expiry data from both contracts
  if (wrappedNames.length === 0) {
    return { desynced, errors, wrapped, unwrapped };
  }

  const registrarExpiryCalls = wrappedNames.map(({ labelHash }) => ({
    address: BASE_REGISTRAR,
    abi: BASE_REGISTRAR_ABI,
    functionName: 'nameExpires' as const,
    args: [labelHash] as const,
  }));

  const wrapperDataCalls = wrappedNames.map(({ record }) => {
    const nodeHash = namehash(record.name);
    const nodeHashBigInt = BigInt(nodeHash);
    return {
      address: NAME_WRAPPER,
      abi: NAME_WRAPPER_ABI,
      functionName: 'getData' as const,
      args: [nodeHashBigInt] as const,
    };
  });

  try {
    const [registrarResults, wrapperResults] = await Promise.all([
      client.multicall({ contracts: registrarExpiryCalls, allowFailure: true }),
      client.multicall({ contracts: wrapperDataCalls, allowFailure: true }),
    ]);

    for (let i = 0; i < wrappedNames.length; i++) {
      const { record } = wrappedNames[i];
      const registrarResult = registrarResults[i];
      const wrapperResult = wrapperResults[i];

      if (registrarResult.status === 'failure' || wrapperResult.status === 'failure') {
        errors++;
        continue;
      }

      const registrarExpiry = registrarResult.result as bigint;
      const [wrapperOwner, fuses, wrapperExpiry] = wrapperResult.result as [string, number, bigint];

      // Expected wrapper expiry = registrar expiry + grace period
      const expectedWrapperExpiry = registrarExpiry + GRACE_PERIOD;

      // Check for desync (only flag if wrapper expiry is LESS than expected - the real issue)
      if (BigInt(wrapperExpiry) !== expectedWrapperExpiry) {
        const diff = expectedWrapperExpiry - BigInt(wrapperExpiry);
        const diffDays = Number(diff) / 86400;
        const now = BigInt(Math.floor(Date.now() / 1000));
        const wrapperExpiredFlag = BigInt(wrapperExpiry) < now;

        // Only report if wrapper is behind (positive diff means wrapper needs updating)
        if (diff > 0n) {
          desynced.push({
            id: record.id,
            name: record.name,
            tokenId: record.token_id,
            ownerAddress: record.owner_address,
            registrarExpiry,
            wrapperExpiry: BigInt(wrapperExpiry),
            expectedWrapperExpiry,
            diffSeconds: diff,
            diffDays,
            wrapperExpired: wrapperExpiredFlag,
          });
        }
      }
    }
  } catch (error: any) {
    errors += wrappedNames.length;
    if (VERBOSE) {
      console.error(`\nExpiry multicall failed: ${error.message}`);
    }
  }

  return { desynced, errors, wrapped, unwrapped };
}

/**
 * Check a specific name for desync status
 */
async function checkSpecificName(client: PublicClient, name: string) {
  const label = name.replace('.eth', '');
  const labelHashBigInt = computeLabelhash(label);

  console.log(`Checking: ${name}`);
  console.log(`Label: ${label}`);
  console.log(`Labelhash: 0x${labelHashBigInt.toString(16)}`);
  console.log('');

  // Check if name is wrapped
  let registrarOwner: string;
  try {
    registrarOwner = await client.readContract({
      address: BASE_REGISTRAR,
      abi: BASE_REGISTRAR_ABI,
      functionName: 'ownerOf',
      args: [labelHashBigInt],
    });
    console.log(`BaseRegistrar owner: ${registrarOwner}`);
  } catch (error: any) {
    console.log(`ERROR: ownerOf failed - ${error.message}`);
    console.log('Name may be expired or not registered.');
    return;
  }

  const isWrapped = registrarOwner.toLowerCase() === NAME_WRAPPER.toLowerCase();
  console.log(`Is wrapped: ${isWrapped}`);

  if (!isWrapped) {
    console.log('\nName is NOT wrapped - desync check not applicable.');
    return;
  }

  // Get expiry from BaseRegistrar
  const registrarExpiry = await client.readContract({
    address: BASE_REGISTRAR,
    abi: BASE_REGISTRAR_ABI,
    functionName: 'nameExpires',
    args: [labelHashBigInt],
  });

  // Get expiry from NameWrapper
  const nodeHash = namehash(name);
  const nodeHashBigInt = BigInt(nodeHash);

  console.log(`Namehash: ${nodeHash}`);

  const [wrapperOwner, fuses, wrapperExpiry] = await client.readContract({
    address: NAME_WRAPPER,
    abi: NAME_WRAPPER_ABI,
    functionName: 'getData',
    args: [nodeHashBigInt],
  });

  const expectedWrapperExpiry = registrarExpiry + GRACE_PERIOD;
  const isDesynced = BigInt(wrapperExpiry) !== expectedWrapperExpiry;

  console.log('');
  console.log('=== Expiry Comparison ===');
  console.log(`BaseRegistrar expiry:   ${new Date(Number(registrarExpiry) * 1000).toISOString()} (${registrarExpiry})`);
  console.log(`NameWrapper expiry:     ${new Date(Number(wrapperExpiry) * 1000).toISOString()} (${wrapperExpiry})`);
  console.log(`Expected wrapper expiry: ${new Date(Number(expectedWrapperExpiry) * 1000).toISOString()} (${expectedWrapperExpiry})`);
  console.log(`Grace period:           ${Number(GRACE_PERIOD) / 86400} days (${GRACE_PERIOD} seconds)`);
  console.log('');

  const diff = expectedWrapperExpiry - BigInt(wrapperExpiry);
  const diffDays = Number(diff) / 86400;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const wrapperExpiredFlag = BigInt(wrapperExpiry) < now;
  const registrarExpiredFlag = registrarExpiry < now;

  console.log(`Wrapper expired: ${wrapperExpiredFlag} (${wrapperExpiredFlag ? 'YES - purchases will fail!' : 'No'})`);
  console.log(`Registrar expired: ${registrarExpiredFlag}`);
  console.log('');

  if (isDesynced && diff > 0n) {
    const severity = wrapperExpiredFlag ? '🚨 CRITICAL' : '⚠️  WARNING';
    console.log(`${severity}: NAME IS DESYNCED!`);
    console.log(`   Wrapper expiry is ${diffDays.toFixed(2)} days behind expected.`);
    if (wrapperExpiredFlag && !registrarExpiredFlag) {
      console.log('');
      console.log('   🚨 PURCHASES WILL FAIL: Wrapper thinks name is expired,');
      console.log('      but registrar says it is still valid!');
    }
    console.log('');
    console.log('This name was likely renewed through the old ETHRegistrarController');
    console.log('instead of the NameWrapper-aware controller.');
  } else if (diff < 0n) {
    console.log(`ℹ️  Wrapper expiry is ${Math.abs(diffDays).toFixed(2)} days AHEAD of expected (unusual but harmless).`);
  } else {
    console.log(`✅ Name is properly synced.`);
  }

  console.log('');
  console.log('=== Additional Info ===');
  console.log(`NameWrapper owner: ${wrapperOwner}`);
  console.log(`Fuses: ${fuses}`);
}

async function main() {
  const pool = getPostgresPool();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
    batch: {
      multicall: true,
    },
  });

  console.log('=== Find Desynced Wrapped ENS Names (OPTIMIZED) ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --save to persist)' : 'SAVING RESULTS'}`);
  console.log(`RPC URL: ${config.blockchain.rpcUrl.substring(0, 30)}...`);
  console.log(`Batch size: ${MULTICALL_BATCH_SIZE} names/multicall, ${CONCURRENT_BATCHES} concurrent`);
  if (LIMIT > 0) console.log(`Limit: ${LIMIT}`);
  if (SPECIFIC_NAME) console.log(`Checking specific name: ${SPECIFIC_NAME}`);
  console.log('');

  // If checking a specific name, do that directly
  if (SPECIFIC_NAME) {
    await checkSpecificName(client, SPECIFIC_NAME);
    await pool.end();
    return;
  }

  // Get all .eth names from database that are not expired beyond grace period
  // 111 days = 90 days grace + 21 days premium decay
  const countQuery = `
    SELECT COUNT(*) FROM ens_names
    WHERE name LIKE '%.eth'
    AND name NOT LIKE '%.%.eth'
    AND expiry_date > NOW() - INTERVAL '111 days'
  `;
  const countResult = await pool.query(countQuery);
  const totalInDb = parseInt(countResult.rows[0].count);
  const total = LIMIT > 0 ? Math.min(totalInDb, LIMIT) : totalInDb;

  console.log(`Total .eth names in database: ${totalInDb.toLocaleString()}`);
  console.log(`Names to check: ${total.toLocaleString()}${LIMIT > 0 ? ` (limited)` : ''}\n`);

  const allDesynced: DesyncedName[] = [];
  let processed = 0;
  let wrapped = 0;
  let unwrapped = 0;
  let errors = 0;
  let offset = 0;
  const startTime = Date.now();

  while (processed < total) {
    // Fetch multiple batches worth of names for concurrent processing
    const fetchSize = MULTICALL_BATCH_SIZE * CONCURRENT_BATCHES;
    const remainingToProcess = total - processed;
    const batchLimit = Math.min(fetchSize, remainingToProcess);

    const result = await pool.query(
      `SELECT id, name, token_id, owner_address FROM ens_names
       WHERE name LIKE '%.eth'
       AND name NOT LIKE '%.%.eth'
       AND expiry_date > NOW() - INTERVAL '111 days'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [batchLimit, offset]
    );

    if (result.rows.length === 0) break;

    const names: NameRecord[] = result.rows;

    // Split into batches for concurrent processing
    const batches: NameRecord[][] = [];
    for (let i = 0; i < names.length; i += MULTICALL_BATCH_SIZE) {
      batches.push(names.slice(i, i + MULTICALL_BATCH_SIZE));
    }

    // Process batches concurrently
    const batchPromises = batches.map(batch => processBatchWithMulticall(client, batch));
    const batchResults = await Promise.all(batchPromises);

    // Aggregate results
    for (const batchResult of batchResults) {
      allDesynced.push(...batchResult.desynced);
      errors += batchResult.errors;
      wrapped += batchResult.wrapped;
      unwrapped += batchResult.unwrapped;

      // Log desynced names as they're found
      for (const d of batchResult.desynced) {
        const severity = d.wrapperExpired ? '🚨 CRITICAL' : '⚠️  WARNING';
        console.log(`\n${severity}: ${d.name} (diff: ${d.diffDays.toFixed(2)} days${d.wrapperExpired ? ', WRAPPER EXPIRED!' : ''})`);
      }
    }

    processed += names.length;
    offset += names.length;

    // Progress update
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const eta = (total - processed) / rate;

    process.stdout.write(
      `\rProgress: ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed / total) * 100)}%) | ` +
      `Wrapped: ${wrapped.toLocaleString()} | Unwrapped: ${unwrapped.toLocaleString()} | ` +
      `Desynced: ${allDesynced.length} | Errors: ${errors} | ` +
      `Rate: ${Math.round(rate)}/s | ETA: ${Math.round(eta)}s    `
    );

    // Small delay between batch groups
    await new Promise(resolve => setTimeout(resolve, RPC_DELAY_MS));
  }

  const totalTime = (Date.now() - startTime) / 1000;

  const criticalCount = allDesynced.filter(d => d.wrapperExpired).length;
  const warningCount = allDesynced.filter(d => !d.wrapperExpired).length;

  console.log('\n\n=== Results ===');
  console.log(`Total processed: ${processed.toLocaleString()}`);
  console.log(`Wrapped names: ${wrapped.toLocaleString()}`);
  console.log(`Unwrapped names: ${unwrapped.toLocaleString()}`);
  console.log(`Errors (skipped): ${errors.toLocaleString()}`);
  console.log(`Desynced names found: ${allDesynced.length}`);
  console.log(`  🚨 Critical (wrapper expired): ${criticalCount}`);
  console.log(`  ⚠️  Warning (wrapper not yet expired): ${warningCount}`);
  console.log(`Total time: ${Math.round(totalTime)}s (${Math.round(processed / totalTime)}/s)`);

  if (allDesynced.length > 0) {
    // Sort: critical first (wrapper expired), then by diff (largest first)
    allDesynced.sort((a, b) => {
      if (a.wrapperExpired !== b.wrapperExpired) {
        return a.wrapperExpired ? -1 : 1;
      }
      return Number(b.diffSeconds - a.diffSeconds);
    });

    if (criticalCount > 0) {
      console.log('\n=== 🚨 CRITICAL: Wrapper Already Expired (purchases will fail) ===');
      for (const d of allDesynced.filter(x => x.wrapperExpired)) {
        console.log(`  ${d.name} - diff: ${d.diffDays.toFixed(2)} days`);
      }
    }

    if (warningCount > 0) {
      console.log('\n=== ⚠️  WARNING: Desynced but not yet expired ===');
      for (const d of allDesynced.filter(x => !x.wrapperExpired)) {
        console.log(`  ${d.name} - diff: ${d.diffDays.toFixed(2)} days`);
      }
    }

    // Save to file
    if (!DRY_RUN) {
      const fs = await import('fs');

      // CSV output
      const csvHeader = 'name,owner_address,severity,diff_days,wrapper_expired,registrar_expiry,wrapper_expiry,expected_wrapper_expiry,diff_seconds,id,token_id';
      const csvRows = allDesynced.map(d => [
        d.name,
        d.ownerAddress || '',
        d.wrapperExpired ? 'critical' : 'warning',
        d.diffDays.toFixed(2),
        d.wrapperExpired ? 'true' : 'false',
        new Date(Number(d.registrarExpiry) * 1000).toISOString(),
        new Date(Number(d.wrapperExpiry) * 1000).toISOString(),
        new Date(Number(d.expectedWrapperExpiry) * 1000).toISOString(),
        d.diffSeconds.toString(),
        d.id,
        d.tokenId,
      ].join(','));

      const csvContent = [csvHeader, ...csvRows].join('\n');
      const csvPath = 'desynced-names.csv';
      fs.writeFileSync(csvPath, csvContent);
      console.log(`\nResults saved to ${csvPath}`);
      console.log(`  Total: ${allDesynced.length} | Critical: ${criticalCount} | Warning: ${warningCount}`);
    } else {
      console.log('\n[DRY RUN] Run with --save to persist results to desynced-names.csv');
    }
  }

  await pool.end();
}

main()
  .then(() => {
    console.log('\nScript completed');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nScript failed:', err);
    process.exit(1);
  });
