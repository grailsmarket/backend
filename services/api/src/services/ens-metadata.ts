import { getPostgresPool, config, processAddressRecords, type AddressRecord, processContenthash, type ContenthashRecord, needsEnsWorkerFallback, fetchTextRecordsFromEnsWorker, fetchTextRecordsOnChain } from '../../../shared/src';
import { logger } from '../utils/logger';

const METADATA_TTL_HOURS = 72;

export interface EnsMetadata {
  [key: string]: string | AddressRecord[] | ContenthashRecord | undefined;
  chains?: AddressRecord[];
  contenthash?: ContenthashRecord;
}

interface FreshMetadataResult {
  metadata: EnsMetadata;
  source: 'graph' | 'worker' | 'cache';
}

/**
 * Always fetch fresh metadata from The Graph, bypassing cache.
 * Database sync happens asynchronously to avoid slowing down the response.
 *
 * @param ensNameId - Database ID of the ENS name
 * @param name - Full ENS name (e.g., "vitalik.eth")
 * @returns Object with metadata from The Graph
 */
export async function fetchFreshMetadata(
  ensNameId: number,
  name: string
): Promise<FreshMetadataResult> {
  logger.info({ name, ensNameId }, 'Fetching fresh metadata from Graph (bypassing cache)');

  try {
    const metadata = await fetchMetadataFromGraph(name);

    // Sync to database asynchronously - fire and forget
    syncMetadataToDatabase(ensNameId, name, metadata).catch((error) => {
      logger.error({ error, name, ensNameId }, 'Async metadata sync failed');
    });

    return { metadata, source: 'graph' };
  } catch (error: any) {
    logger.error(
      { error: error?.message, cause: error?.cause?.message || error?.cause, url: config.theGraph.ensSubgraphUrl, name, ensNameId },
      'Failed to fetch fresh metadata from Graph, trying ENS worker standalone'
    );

    // Graph failed entirely — try ENS worker standalone
    try {
      const workerRecords = await fetchTextRecordsFromEnsWorker(name);
      if (Object.keys(workerRecords).length > 0) {
        logger.info({ name, keys: Object.keys(workerRecords) }, 'ENS worker standalone fallback succeeded');
        syncMetadataToDatabase(ensNameId, name, workerRecords).catch((syncError) => {
          logger.error({ error: syncError, name, ensNameId }, 'Async metadata sync failed (worker fallback)');
        });
        return { metadata: workerRecords, source: 'worker' };
      }
    } catch (workerError: any) {
      logger.warn({ error: workerError?.message, name }, 'ENS worker standalone fallback also failed');
    }

    // Final fallback: cached metadata from the database
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
 * Check if metadata needs refresh and fetch from The Graph if stale (>72 hours)
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

  logger.info({ name, ensNameId, lastUpdated: currentMetadataUpdatedAt }, 'Metadata stale, fetching from Graph');

  try {
    const metadata = await fetchMetadataFromGraph(name);

    // Update database with fresh metadata
    const pool = getPostgresPool();
    await pool.query(
      `UPDATE ens_names
       SET metadata = $1, metadata_updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(metadata), ensNameId]
    );

    logger.info(
      { name, ensNameId, keys: Object.keys(metadata) },
      'Metadata refreshed from Graph'
    );

    return { refreshed: true, metadata };
  } catch (error) {
    logger.error({ error, name, ensNameId }, 'Failed to refresh metadata from Graph');
    // Return empty, don't fail the request - serve stale data instead
    return { refreshed: false, metadata: {} };
  }
}

/**
 * Fetch text records and address records from The Graph ENS subgraph
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
          textChangeds {
            key
            value
          }
          addr {
            id
          }
          coinTypes
          multicoinAddrChangeds {
            coinType
            addr
          }
          contentHash
          contenthashChangeds {
            hash
          }
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
