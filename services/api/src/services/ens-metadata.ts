import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';

const METADATA_TTL_HOURS = 72;

interface MetadataRefreshResult {
  refreshed: boolean;
  metadata: Record<string, string>;
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
 * Fetch text records from The Graph ENS subgraph
 *
 * @param name - Full ENS name (e.g., "vitalik.eth")
 * @returns Object mapping text record keys to values
 */
async function fetchMetadataFromGraph(name: string): Promise<Record<string, string>> {
  const query = `
    query GetDomain($name: String!) {
      domains(where: { name: $name }) {
        resolver {
          texts
          textChangeds {
            key
            value
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
  });

  if (!response.ok) {
    throw new Error(`Graph request failed: ${response.status} ${response.statusText}`);
  }

  const json: any = await response.json();

  if (json.errors) {
    throw new Error(`Graph query error: ${JSON.stringify(json.errors)}`);
  }

  const domain = json.data?.domains?.[0];

  if (!domain?.resolver?.textChangeds) {
    return {};
  }

  // Build metadata object from text records
  // textChangeds contains all historical changes, we want the latest value for each key
  const metadata: Record<string, string> = {};
  for (const record of domain.resolver.textChangeds) {
    if (record.key && record.value) {
      metadata[record.key] = record.value;
    }
  }

  return metadata;
}
