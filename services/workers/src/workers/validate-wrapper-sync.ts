/**
 * Wrapper Sync Validation Worker
 *
 * Validates that wrapped ENS names have synchronized expiry dates between
 * the BaseRegistrar and NameWrapper contracts.
 *
 * A name is desynced when:
 *   wrapperExpiry != registrarExpiry + GRACE_PERIOD (90 days)
 *
 * This happens when a wrapped name is renewed through the old ETHRegistrarController
 * instead of the NameWrapper-aware controller.
 *
 * Reference: https://github.com/ensdomains/ens-app-v3/pull/1107
 */

import PgBoss from 'pg-boss';
import { createPublicClient, http, namehash, parseAbi, keccak256, toHex } from 'viem';
import { mainnet } from 'viem/chains';
import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';

const pool = getPostgresPool();

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

// Batch settings
const MULTICALL_BATCH_SIZE = 100; // Names per multicall batch
const SCHEDULER_BATCH_SIZE = 500; // Names to fetch per scheduler run
const SCHEDULER_INTERVAL_MINUTES = 5;

interface NameRecord {
  id: number;
  name: string;
  token_id: string;
}

interface DesyncResult {
  id: number;
  isDesynced: boolean;
  wrapperExpired?: boolean;
  diffDays?: number;
}

// Viem client - lazily initialized
let viemClient: ReturnType<typeof createPublicClient> | null = null;

function getViemClient() {
  if (!viemClient) {
    const rpcUrl = config.blockchain.rpcUrl;
    if (!rpcUrl) {
      throw new Error('RPC_URL not configured');
    }
    viemClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl),
      batch: {
        multicall: true,
      },
    });
  }
  return viemClient;
}

/**
 * Compute labelhash from label (e.g., "vitalik" -> labelhash)
 */
function computeLabelhash(label: string): bigint {
  const hash = keccak256(toHex(label));
  return BigInt(hash);
}

/**
 * Process a batch of names using multicall to check wrapper sync status
 */
async function validateBatch(names: NameRecord[]): Promise<Map<number, DesyncResult>> {
  const client = getViemClient();
  const results = new Map<number, DesyncResult>();

  if (names.length === 0) {
    return results;
  }

  // Step 1: Check ownerOf on BaseRegistrar to find which names are wrapped
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
    logger.error({ error: error.message }, 'Owner multicall failed');
    // Mark all as checked but not desynced (unknown state)
    for (const record of names) {
      results.set(record.id, { id: record.id, isDesynced: false });
    }
    return results;
  }

  // Find which names are wrapped
  const wrappedNames: { record: NameRecord; labelHash: bigint }[] = [];
  for (let i = 0; i < names.length; i++) {
    const result = ownerResults[i];
    if (result.status === 'failure') {
      // Failed to check - mark as checked but not desynced
      results.set(names[i].id, { id: names[i].id, isDesynced: false });
      continue;
    }

    const owner = (result.result as string).toLowerCase();
    if (owner === NAME_WRAPPER.toLowerCase()) {
      // Name is wrapped - need to check expiry sync
      const label = names[i].name.replace('.eth', '');
      wrappedNames.push({ record: names[i], labelHash: computeLabelhash(label) });
    } else {
      // Not wrapped - no desync possible
      results.set(names[i].id, { id: names[i].id, isDesynced: false });
    }
  }

  if (wrappedNames.length === 0) {
    return results;
  }

  // Step 2: For wrapped names, get expiry data from both contracts
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

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (let i = 0; i < wrappedNames.length; i++) {
      const { record } = wrappedNames[i];
      const registrarResult = registrarResults[i];
      const wrapperResult = wrapperResults[i];

      if (registrarResult.status === 'failure' || wrapperResult.status === 'failure') {
        results.set(record.id, { id: record.id, isDesynced: false });
        continue;
      }

      const registrarExpiry = registrarResult.result as bigint;
      const [, , wrapperExpiry] = wrapperResult.result as [string, number, bigint];

      // Expected wrapper expiry = registrar expiry + grace period
      const expectedWrapperExpiry = registrarExpiry + GRACE_PERIOD;

      // Check for desync (only flag if wrapper expiry is LESS than expected)
      const diff = expectedWrapperExpiry - BigInt(wrapperExpiry);

      if (diff > 0n) {
        // Wrapper is behind - this is the problematic case
        const diffDays = Number(diff) / 86400;
        const wrapperExpired = BigInt(wrapperExpiry) < now;

        results.set(record.id, {
          id: record.id,
          isDesynced: true,
          wrapperExpired,
          diffDays,
        });

        logger.info({
          name: record.name,
          diffDays: diffDays.toFixed(2),
          wrapperExpired,
        }, 'Desynced wrapped name detected');
      } else {
        // Wrapper is equal or ahead - not a problem
        results.set(record.id, { id: record.id, isDesynced: false });
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Expiry multicall failed');
    // Mark remaining as checked but not desynced
    for (const { record } of wrappedNames) {
      if (!results.has(record.id)) {
        results.set(record.id, { id: record.id, isDesynced: false });
      }
    }
  }

  return results;
}

/**
 * Update database with desync check results
 */
async function updateDesyncStatus(results: Map<number, DesyncResult>): Promise<void> {
  if (results.size === 0) return;

  const now = new Date();

  // Batch update - use CASE for efficiency
  const ids = Array.from(results.keys());
  const desynced = Array.from(results.values()).filter(r => r.isDesynced);
  const notDesynced = Array.from(results.values()).filter(r => !r.isDesynced);

  // Update desynced names
  if (desynced.length > 0) {
    const desyncedIds = desynced.map(r => r.id);
    await pool.query(
      `UPDATE ens_names
       SET is_desynced = TRUE, desync_checked_at = $1
       WHERE id = ANY($2)`,
      [now, desyncedIds]
    );
    logger.info({ count: desyncedIds.length }, 'Marked names as desynced');
  }

  // Update non-desynced names (clear any previous desync flag)
  if (notDesynced.length > 0) {
    const notDesyncedIds = notDesynced.map(r => r.id);
    await pool.query(
      `UPDATE ens_names
       SET is_desynced = FALSE, desync_checked_at = $1
       WHERE id = ANY($2)`,
      [now, notDesyncedIds]
    );
  }
}

/**
 * Job handler for batch wrapper sync validation
 */
async function validateWrapperSyncJob(job: PgBoss.Job<{ nameIds: number[] }>) {
  const { nameIds } = job.data;

  try {
    logger.debug({ count: nameIds.length }, 'Validating wrapper sync for names');

    // Fetch name records
    const result = await pool.query(
      `SELECT id, name, token_id FROM ens_names WHERE id = ANY($1)`,
      [nameIds]
    );

    const names: NameRecord[] = result.rows;

    // Process in multicall batches
    const allResults = new Map<number, DesyncResult>();

    for (let i = 0; i < names.length; i += MULTICALL_BATCH_SIZE) {
      const batch = names.slice(i, i + MULTICALL_BATCH_SIZE);
      const batchResults = await validateBatch(batch);

      for (const [id, result] of batchResults) {
        allResults.set(id, result);
      }
    }

    // Update database
    await updateDesyncStatus(allResults);

    const desyncedCount = Array.from(allResults.values()).filter(r => r.isDesynced).length;
    logger.info(
      { total: names.length, desynced: desyncedCount },
      'Wrapper sync validation complete'
    );

  } catch (error: any) {
    logger.error({ error: error.message, count: nameIds.length }, 'Error in wrapper sync validation');
    throw error; // Let pg-boss retry
  }
}

/**
 * Register the wrapper sync validation worker
 */
export async function registerWrapperSyncWorker(boss: PgBoss) {
  await boss.work(
    'validate-wrapper-sync',
    { teamSize: 2, teamConcurrency: 1 },
    validateWrapperSyncJob
  );
  logger.info('Wrapper sync validation worker registered');
}

/**
 * Register the periodic wrapper sync scheduler
 */
export async function registerWrapperSyncScheduler(boss: PgBoss) {
  // Scheduler job - finds names that need checking and queues batch jobs
  await boss.work(
    'periodic-wrapper-sync-validation',
    { teamSize: 1 },
    async () => {
      try {
        // Priority order:
        // 1. Names with active listings (purchases would fail)
        // 2. Other .eth names not yet checked or oldest checked
        const result = await pool.query(`
          SELECT en.id, en.name, en.token_id
          FROM ens_names en
          LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
          WHERE en.name LIKE '%.eth'
            AND en.name NOT LIKE '%.%.eth'
            AND en.expiry_date > NOW() - INTERVAL '111 days'
          ORDER BY
            CASE WHEN l.id IS NOT NULL THEN 0 ELSE 1 END,
            COALESCE(en.desync_checked_at, '1970-01-01') ASC
          LIMIT $1
        `, [SCHEDULER_BATCH_SIZE]);

        if (result.rows.length === 0) {
          logger.debug('No names need wrapper sync validation');
          return;
        }

        const nameIds = result.rows.map((row: any) => row.id);

        logger.info({ count: nameIds.length }, 'Scheduling wrapper sync validation batch');

        // Queue validation job
        await boss.send('validate-wrapper-sync', { nameIds });

      } catch (error: any) {
        logger.error({ error: error.message }, 'Error in periodic wrapper sync scheduler');
        throw error;
      }
    }
  );

  // Schedule to run every 5 minutes
  await boss.schedule(
    'periodic-wrapper-sync-validation',
    `*/${SCHEDULER_INTERVAL_MINUTES} * * * *`,
    {},
    { tz: 'UTC' }
  );

  logger.info('Wrapper sync validation scheduler registered');
}
