import { getPostgresPool, config } from '../../../shared/src';
import { createPublicClient, http, namehash, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { keccak256, toHex } from 'viem';

/**
 * Script to detect wrapped ENS names with out-of-sync expiry dates
 *
 * A name is desynced when:
 * - BaseRegistrar.ownerOf(labelhash) === NameWrapper address (name is wrapped)
 * - NameWrapper.getData(namehash).expiry !== BaseRegistrar.nameExpires(labelhash) + GRACE_PERIOD
 *
 * This happens when a wrapped name is renewed through the old ETHRegistrarController
 * (unwrapped controller) instead of the NameWrapper-aware controller. The expiry gets
 * updated in the BaseRegistrar but NOT in the NameWrapper.
 *
 * Reference: https://github.com/ensdomains/ens-app-v3/pull/1107
 *
 * Usage:
 *   npx tsx src/scripts/find-desynced-wrapped-names.ts [--save] [--limit=N] [--verbose]
 */

// Contract addresses
const BASE_REGISTRAR = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
const NAME_WRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';

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
  // Ensure it ends with .eth
  if (!SPECIFIC_NAME.endsWith('.eth')) {
    SPECIFIC_NAME = SPECIFIC_NAME + '.eth';
  }
}

// Batch settings
const BATCH_SIZE = 50; // Names per batch (limited by RPC multicall)
const RPC_DELAY_MS = 100; // Delay between batches to avoid rate limiting

interface DesyncedName {
  id: number;
  name: string;
  tokenId: string;
  registrarExpiry: bigint;
  wrapperExpiry: bigint;
  expectedWrapperExpiry: bigint;
  diffSeconds: bigint;
  diffDays: number;
}

/**
 * Compute labelhash from label (e.g., "vitalik" -> labelhash)
 * labelhash = keccak256(label)
 */
function computeLabelhash(label: string): bigint {
  const hash = keccak256(toHex(label));
  return BigInt(hash);
}

/**
 * Check a specific name for desync status
 */
async function checkSpecificName(client: any, name: string) {
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

  if (isDesynced) {
    const diff = expectedWrapperExpiry - BigInt(wrapperExpiry);
    const diffDays = Number(diff) / 86400;
    console.log(`⚠️  NAME IS DESYNCED!`);
    console.log(`   Difference: ${diffDays.toFixed(2)} days (${diff} seconds)`);
    console.log('');
    console.log('This name was likely renewed through the old ETHRegistrarController');
    console.log('instead of the NameWrapper-aware controller.');
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
  });

  console.log('=== Find Desynced Wrapped ENS Names ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --save to persist)' : 'SAVING RESULTS'}`);
  console.log(`RPC URL: ${config.blockchain.rpcUrl.substring(0, 30)}...`);
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
  console.log(`Total names to check: ${total.toLocaleString()}${LIMIT > 0 ? ` (limited from ${totalInDb.toLocaleString()})` : ''}\n`);

  const desynced: DesyncedName[] = [];
  let processed = 0;
  let wrapped = 0;
  let unwrapped = 0;
  let errors = 0;
  let offset = 0;
  const startTime = Date.now();

  while (processed < total) {
    // Fetch batch of names (limit batch size if we're near the total limit)
    const remainingToProcess = total - processed;
    const batchLimit = Math.min(BATCH_SIZE, remainingToProcess);

    const result = await pool.query(
      `SELECT id, name, token_id FROM ens_names
       WHERE name LIKE '%.eth'
       AND name NOT LIKE '%.%.eth'
       AND expiry_date > NOW() - INTERVAL '111 days'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [batchLimit, offset]
    );

    if (result.rows.length === 0) break;

    // Process each name
    for (const row of result.rows) {
      const { id, name, token_id } = row;
      const label = name.replace('.eth', '');

      try {
        // Get labelhash for BaseRegistrar calls
        const labelHashBigInt = computeLabelhash(label);

        // Check if name is wrapped (owner on BaseRegistrar is NameWrapper)
        let registrarOwner: string;
        try {
          registrarOwner = await client.readContract({
            address: BASE_REGISTRAR,
            abi: BASE_REGISTRAR_ABI,
            functionName: 'ownerOf',
            args: [labelHashBigInt],
          });
        } catch (ownerError: any) {
          // Name may be expired or not exist on-chain
          if (VERBOSE) {
            console.log(`  [SKIP] ${name}: ownerOf failed (likely expired)`);
          }
          errors++;
          processed++;
          continue;
        }

        if (registrarOwner.toLowerCase() !== NAME_WRAPPER.toLowerCase()) {
          // Not wrapped, skip
          unwrapped++;
          processed++;
          continue;
        }

        wrapped++;

        // Get expiry from BaseRegistrar
        const registrarExpiry = await client.readContract({
          address: BASE_REGISTRAR,
          abi: BASE_REGISTRAR_ABI,
          functionName: 'nameExpires',
          args: [labelHashBigInt],
        });

        // Get expiry from NameWrapper using namehash
        const nodeHash = namehash(name);
        const nodeHashBigInt = BigInt(nodeHash);

        const [wrapperOwner, fuses, wrapperExpiry] = await client.readContract({
          address: NAME_WRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: 'getData',
          args: [nodeHashBigInt],
        });

        // Expected wrapper expiry = registrar expiry + grace period
        const expectedWrapperExpiry = registrarExpiry + GRACE_PERIOD;

        // Check for desync (wrapper expiry should equal registrar expiry + grace period)
        if (BigInt(wrapperExpiry) !== expectedWrapperExpiry) {
          const diff = expectedWrapperExpiry - BigInt(wrapperExpiry);
          const diffDays = Number(diff) / 86400;

          desynced.push({
            id,
            name,
            tokenId: token_id,
            registrarExpiry,
            wrapperExpiry: BigInt(wrapperExpiry),
            expectedWrapperExpiry,
            diffSeconds: diff,
            diffDays,
          });

          console.log(`\n⚠️  DESYNCED: ${name}`);
          console.log(`   Registrar expiry: ${new Date(Number(registrarExpiry) * 1000).toISOString()}`);
          console.log(`   Wrapper expiry:   ${new Date(Number(wrapperExpiry) * 1000).toISOString()}`);
          console.log(`   Expected wrapper: ${new Date(Number(expectedWrapperExpiry) * 1000).toISOString()}`);
          console.log(`   Diff: ${diffDays.toFixed(2)} days`);
        } else if (VERBOSE) {
          console.log(`  [OK] ${name}: wrapper expiry matches`);
        }
      } catch (error: any) {
        // Skip names that fail (might be expired or invalid)
        if (VERBOSE) {
          console.error(`  [ERROR] ${name}: ${error.message}`);
        }
        errors++;
      }

      processed++;
    }

    offset += BATCH_SIZE;

    // Progress update
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const eta = (total - processed) / rate;

    process.stdout.write(
      `\rProgress: ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed / total) * 100)}%) | ` +
      `Wrapped: ${wrapped.toLocaleString()} | Unwrapped: ${unwrapped.toLocaleString()} | ` +
      `Desynced: ${desynced.length} | Errors: ${errors} | ` +
      `ETA: ${Math.round(eta)}s    `
    );

    // Add delay between batches to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, RPC_DELAY_MS));
  }

  console.log('\n\n=== Results ===');
  console.log(`Total processed: ${processed.toLocaleString()}`);
  console.log(`Wrapped names found: ${wrapped.toLocaleString()}`);
  console.log(`Unwrapped names found: ${unwrapped.toLocaleString()}`);
  console.log(`Errors (skipped): ${errors.toLocaleString()}`);
  console.log(`Desynced names found: ${desynced.length}`);

  if (desynced.length > 0) {
    console.log('\n=== Desynced Names Summary ===');
    // Sort by diff (largest first)
    desynced.sort((a, b) => Number(b.diffSeconds - a.diffSeconds));

    for (const d of desynced) {
      console.log(`  ${d.name} - diff: ${d.diffDays.toFixed(2)} days`);
    }

    // Save to file
    if (!DRY_RUN) {
      const fs = await import('fs');
      const output = {
        timestamp: new Date().toISOString(),
        total_checked: processed,
        wrapped_count: wrapped,
        unwrapped_count: unwrapped,
        desynced_count: desynced.length,
        names: desynced.map(d => ({
          id: d.id,
          name: d.name,
          token_id: d.tokenId,
          registrar_expiry: new Date(Number(d.registrarExpiry) * 1000).toISOString(),
          registrar_expiry_unix: d.registrarExpiry.toString(),
          wrapper_expiry: new Date(Number(d.wrapperExpiry) * 1000).toISOString(),
          wrapper_expiry_unix: d.wrapperExpiry.toString(),
          expected_wrapper_expiry: new Date(Number(d.expectedWrapperExpiry) * 1000).toISOString(),
          expected_wrapper_expiry_unix: d.expectedWrapperExpiry.toString(),
          diff_seconds: d.diffSeconds.toString(),
          diff_days: d.diffDays,
        })),
      };
      const outputPath = 'desynced-names.json';
      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
      console.log(`\nResults saved to ${outputPath}`);
    } else {
      console.log('\n[DRY RUN] Run with --save to persist results to desynced-names.json');
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
