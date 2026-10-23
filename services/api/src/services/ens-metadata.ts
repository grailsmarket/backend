import { getPostgresPool, config, processAddressRecords, processContenthash, needsEnsWorkerFallback, fetchTextRecordsFromEnsWorker, fetchTextRecordsOnChain, RESOLVER_EVENTS_FIELDS, normalizeResolverEvents, isEnsV2Name, fetchNameRecordsFromWorker, keepCachedRecordsWithoutResolver, type NameRecords } from '../../../shared/src';
import { logger } from '../utils/logger';

const METADATA_TTL_HOURS = 72;

export type EnsMetadata = NameRecords;

type MetadataSource = 'worker' | 'graph' | 'cache';

interface FreshMetadataResult {
  metadata: EnsMetadata;
  source: MetadataSource;
}

type MetadataLookup =
  | { found: true; metadata: EnsMetadata; source: 'worker' | 'graph' }
  | { found: false };

/**
 * Look up a name's records. The ENS worker (v1, v2 and offchain names) comes first. If it
 * fails, v1 names fall back to The Graph; v2 names aren't in the v1 subgraph, so the error
 * is rethrown and callers serve cached metadata. `found: false` means the worker found no
 * resolver for the name.
 */
async function lookupMetadata(name: string, fresh: boolean): Promise<MetadataLookup> {
  try {
    const result = await fetchNameRecordsFromWorker(name, { fresh });
    return result.found ? { found: true, metadata: result.records, source: 'worker' } : { found: false };
  } catch (error: any) {
    if (await isEnsV2Name(name)) throw error;
    logger.warn({ error: error?.message, name }, 'ENS worker lookup failed, falling back to The Graph');
    return { found: true, metadata: await fetchMetadataFromGraph(name), source: 'graph' };
  }
}

/**
 * Records for a name the worker found no resolver for: the cached records while the name
 * is in its grace period, otherwise none (see keepCachedRecordsWithoutResolver).
 */
async function metadataWithoutResolver(ensNameId: number): Promise<{ metadata: EnsMetadata; keptCache: boolean }> {
  const result = await getPostgresPool().query(
    `SELECT metadata, expiry_date, ens_version FROM ens_names WHERE id = $1`,
    [ensNameId]
  );
  const row = result.rows[0];
  if (row && keepCachedRecordsWithoutResolver(row.expiry_date, row.ens_version)) {
    return { metadata: row.metadata || {}, keptCache: true };
  }
  return { metadata: {}, keptCache: false };
}

/**
 * Always fetch fresh metadata, bypassing caches.
 * Database sync happens asynchronously to avoid slowing down the response.
 *
 * @param ensNameId - Database ID of the ENS name
 * @param name - Full ENS name (e.g., "vitalik.eth")
 */
export async function fetchFreshMetadata(
  ensNameId: number,
  name: string
): Promise<FreshMetadataResult> {
  logger.info({ name, ensNameId }, 'Fetching fresh metadata (bypassing cache)');

  try {
    const lookup = await lookupMetadata(name, true);

    if (!lookup.found) {
      const { metadata, keptCache } = await metadataWithoutResolver(ensNameId);
      if (keptCache) {
        return { metadata, source: 'cache' };
      }
      syncMetadataToDatabase(ensNameId, name, metadata).catch((error) => {
        logger.error({ error, name, ensNameId }, 'Async metadata sync failed');
      });
      return { metadata, source: 'worker' };
    }

    // Sync to database asynchronously - fire and forget
    syncMetadataToDatabase(ensNameId, name, lookup.metadata).catch((error) => {
      logger.error({ error, name, ensNameId }, 'Async metadata sync failed');
    });

    return { metadata: lookup.metadata, source: lookup.source };
  } catch (error: any) {
    logger.error(
      { error: error?.message, cause: error?.cause?.message || error?.cause, name, ensNameId },
      'Failed to fetch fresh metadata, serving cached metadata'
    );

    const pool = getPostgresPool();
    const result = await pool.query(
      `SELECT metadata FROM ens_names WHERE id = $1`,
      [ensNameId]
    );

    const cached = result.rows[0]?.metadata || {};
    return { metadata: cached, source: 'cache' };
  }
}

/**
 * Sync metadata to database in the background
 */
async function syncMetadataToDatabase(
  ensNameId: number,
  name: string,
  metadata: EnsMetadata
): Promise<void> {
  const pool = getPostgresPool();

  await pool.query(
    `UPDATE ens_names
     SET metadata = $1, metadata_updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(metadata), ensNameId]
  );

  logger.debug(
    { name, ensNameId, keys: Object.keys(metadata) },
    'Async metadata sync completed'
  );
}

interface MetadataRefreshResult {
  refreshed: boolean;
  metadata: EnsMetadata;
}

/**
 * Check if metadata needs refresh and refetch it if stale (>72 hours)
 *
 * @param ensNameId - Database ID of the ENS name
 * @param name - Full ENS name (e.g., "vitalik.eth")
 * @param currentMetadataUpdatedAt - Current timestamp of last metadata update
 * @returns Object with refreshed flag and new metadata if fetched
 */
export async function ensureMetadataFresh(
  ensNameId: number,
  name: string,
  currentMetadataUpdatedAt: Date | null
): Promise<MetadataRefreshResult> {
  const staleCutoff = new Date(Date.now() - METADATA_TTL_HOURS * 60 * 60 * 1000);

  // Skip refresh if metadata is fresh
  if (currentMetadataUpdatedAt && currentMetadataUpdatedAt > staleCutoff) {
    return { refreshed: false, metadata: {} };
  }

  logger.info({ name, ensNameId, lastUpdated: currentMetadataUpdatedAt }, 'Metadata stale, refetching');

  try {
    const pool = getPostgresPool();
    const lookup = await lookupMetadata(name, false);

    if (!lookup.found) {
      const { metadata, keptCache } = await metadataWithoutResolver(ensNameId);
      if (keptCache) {
        // Keep the records, but don't look the name up again on every request
        await pool.query(`UPDATE ens_names SET metadata_updated_at = NOW() WHERE id = $1`, [ensNameId]);
        return { refreshed: false, metadata: {} };
      }
      await pool.query(
        `UPDATE ens_names SET metadata = $1, metadata_updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(metadata), ensNameId]
      );
      return { refreshed: true, metadata };
    }

    // Update database with fresh metadata
    await pool.query(
      `UPDATE ens_names
       SET metadata = $1, metadata_updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(lookup.metadata), ensNameId]
    );

    logger.info(
      { name, ensNameId, source: lookup.source, keys: Object.keys(lookup.metadata) },
      'Metadata refreshed'
    );

    return { refreshed: true, metadata: lookup.metadata };
  } catch (error) {
    logger.error({ error, name, ensNameId }, 'Failed to refresh metadata');
    // Return empty, don't fail the request - serve stale data instead
    return { refreshed: false, metadata: {} };
  }
}

/**
 * Fetch text records and address records from The Graph ENS subgraph.
 * Fallback for v1 names when the ENS worker is unavailable.
 *
 * @param name - Full ENS name (e.g., "vitalik.eth")
 * @returns Object with text records and chains array for address records
 */
async function fetchMetadataFromGraph(name: string): Promise<EnsMetadata> {
  const query = `
    query GetDomain($name: String!) {
      domains(where: { name: $name }) {
        resolver {
          address
          texts
          ${RESOLVER_EVENTS_FIELDS}
          addr {
            id
          }
          coinTypes
          contentHash
        }
      }
    }
  `;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph?.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  const response = await fetch(config.theGraph.ensSubgraphUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables: { name: name.toLowerCase() },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Graph request failed: ${response.status} ${response.statusText}`);
  }

  const json: any = await response.json();

  if (json.errors) {
    throw new Error(`Graph query error: ${JSON.stringify(json.errors)}`);
  }

  const domain = json.data?.domains?.[0];
  normalizeResolverEvents(domain?.resolver);
  const metadata: EnsMetadata = {};

  // Build metadata object from text records
  // textChangeds contains all historical changes in order, we want the latest value for each key
  // If a record's most recent value is null/empty, it means the user unset it
  if (domain?.resolver?.textChangeds) {
    for (const record of domain.resolver.textChangeds) {
      if (record.key) {
        if (record.value) {
          metadata[record.key] = record.value;
        } else {
          // Value is null/empty - record was unset, remove it
          delete metadata[record.key];
        }
      }
    }
  }

  // Fallback to ENS worker if resolver doesn't emit values to The Graph
  if (needsEnsWorkerFallback(domain?.resolver?.address, domain?.resolver?.texts, domain?.resolver?.textChangeds)) {
    try {
      const workerRecords = await fetchTextRecordsFromEnsWorker(name);
      Object.assign(metadata, workerRecords);
      logger.info({ name, keys: Object.keys(workerRecords) }, 'ENS worker fallback used for text records');
    } catch (error) {
      logger.warn({ error, name }, 'ENS worker fallback failed, trying on-chain resolution');
      try {
        const textKeys = domain?.resolver?.texts || [];
        const onChainRecords = await fetchTextRecordsOnChain(name, textKeys);
        Object.assign(metadata, onChainRecords);
        logger.info({ name, keys: Object.keys(onChainRecords) }, 'On-chain text record resolution succeeded');
      } catch (onChainError) {
        logger.error({ error: onChainError, name }, 'All text record sources failed');
      }
    }
  }

  // Process address records (multicoinAddrChangeds)
  if (domain?.resolver?.multicoinAddrChangeds) {
    const chains = processAddressRecords(domain.resolver.multicoinAddrChangeds);
    if (chains.length > 0) {
      metadata.chains = chains;
    }
  }

  // Process contenthash
  const contenthash = processContenthash(
    domain?.resolver?.contenthashChangeds,
    domain?.resolver?.contentHash
  );
  if (contenthash) {
    metadata.contenthash = contenthash;
  }

  return metadata;
}
