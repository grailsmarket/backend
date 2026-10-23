import { getPostgresPool, config } from '../../../shared/src';
import { logger } from '../utils/logger';
import { buildNameResult, type SearchResult } from '../utils/response-builder';
import { ensureMetadataFresh, fetchFreshMetadata } from './ens-metadata';

const pool = getPostgresPool();

// ENS Name Wrapper contract address
const NAME_WRAPPER_ADDRESS = config.blockchain.ensNameWrapperAddress.toLowerCase();

/**
 * Resolve full ENS name details for the marketplace.
 *
 * Mirrors the behavior of `GET /api/v1/names/:name`:
 *  1. Look up the name (with vote/watchlist/listing enrichment) via buildNameResult.
 *  2. If not in the database, cold-import it from The Graph (upsert into ens_names)
 *     and re-run buildNameResult. Records aren't imported from The Graph.
 *  3. If found, ensure metadata is fresh (refetches from the ENS worker when stale or,
 *     for a cold import, never fetched). With `freshMetadata`, always refetches,
 *     bypassing caches, the same way `GET /api/v1/names/:name/metadata` does.
 *
 * Returns `null` when the name cannot be resolved at all - callers own the 404.
 *
 * @param name - Full ENS name (e.g., "vitalik.eth")
 * @param userId - Optional authenticated user ID for per-user fields (votes, watchlist)
 * @param options.freshMetadata - Always fetch fresh records instead of only when stale
 */
export async function resolveNameDetails(
  name: string,
  userId?: number,
  options: { freshMetadata?: boolean } = {}
): Promise<SearchResult | null> {
  // Use buildNameResult helper to get name with vote data
  let nameResult = await buildNameResult(name, userId);

  // If name doesn't exist in database, try to fetch from The Graph
  if (!nameResult) {
    try {
      logger.info({ name }, 'Name not found in database, querying The Graph');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph?.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      const graphResponse = await fetch(config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: `
              query GetDomain($name: String!) {
                domains(where: { name: $name }) {
                  id
                  name
                  labelhash
                  registrant {
                    id
                  }
                  wrappedOwner {
                    id
                  }
                  registration {
                    expiryDate
                    registrationDate
                  }
                }
              }
            `,
          variables: {
            name: name.toLowerCase(),
          },
        }),
      });

      const graphData: any = await graphResponse.json();
      const domain = graphData?.data?.domains?.[0];

      if (domain) {
        // Convert labelhash to token ID
        const tokenId = domain.labelhash ? BigInt(domain.labelhash).toString() : null;

        if (tokenId) {
          // Get owner address based on registrant
          // If registrant is NameWrapper, use wrappedOwner; otherwise use registrant
          let ownerAddress: string | null = null;
          if (domain.registrant?.id) {
            const registrant = domain.registrant.id.toLowerCase();
            if (registrant === NAME_WRAPPER_ADDRESS) {
              // Wrapped name: use wrappedOwner
              ownerAddress = domain.wrappedOwner?.id?.toLowerCase() || null;
            } else {
              // Unwrapped name: use registrant
              ownerAddress = registrant;
            }
          }

          let expiryDate: Date | null = null;
          if (domain.registration?.expiryDate) {
            expiryDate = new Date(parseInt(domain.registration.expiryDate) * 1000);
          }

          const registrationDate = domain.registration?.registrationDate ? new Date(parseInt(domain.registration.registrationDate) * 1000) : null;

          // Insert name into database. metadata_updated_at stays NULL on insert so
          // ensureMetadataFresh below fetches the records from the ENS worker.
          const upsertQuery = `
              INSERT INTO ens_names (
                token_id,
                name,
                owner_address,
                expiry_date,
                registration_date,
                metadata,
                metadata_updated_at,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, NULL, NOW(), NOW())
              ON CONFLICT (token_id)
              DO UPDATE SET
                name = EXCLUDED.name,
                owner_address = EXCLUDED.owner_address,
                expiry_date = EXCLUDED.expiry_date,
                registration_date = EXCLUDED.registration_date,
                updated_at = NOW()
              RETURNING id
            `;

          await pool.query(upsertQuery, [
            tokenId,
            domain.name,
            ownerAddress,
            expiryDate,
            registrationDate,
          ]);

          logger.info({ name, tokenId }, 'Successfully imported name from The Graph');

          // Query again to get full data with buildNameResult
          nameResult = await buildNameResult(name, userId);
        }
      }
    } catch (error: any) {
      logger.error({ error, name }, 'Error fetching from The Graph');
    }
  }

  if (!nameResult) {
    return null;
  }

  if (options.freshMetadata) {
    // Always refetch (bypassing caches). The DB sync runs in the background.
    // On a worker failure this returns the cached records, so only bump the
    // timestamp when the records came from a live lookup.
    const { metadata, source } = await fetchFreshMetadata(nameResult.id, nameResult.name);
    nameResult.metadata = metadata;
    if (source !== 'cache') {
      nameResult.metadata_updated_at = new Date();
    }
    return nameResult;
  }

  // Check if metadata needs refresh (synchronous - refetches if stale)
  const { refreshed, metadata: freshMetadata } = await ensureMetadataFresh(
    nameResult.id,
    nameResult.name,
    nameResult.metadata_updated_at
  );

  if (refreshed) {
    // The refresh replaced the stored records, so replace them here too
    // (merging would keep records the owner has since removed)
    nameResult.metadata = freshMetadata;
    nameResult.metadata_updated_at = new Date();
  }

  return nameResult;
}
