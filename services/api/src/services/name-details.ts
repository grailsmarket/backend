import { getPostgresPool, config, processAddressRecords } from '../../../shared/src';
import { logger } from '../utils/logger';
import { buildNameResult, type SearchResult } from '../utils/response-builder';
import { ensureMetadataFresh, type EnsMetadata } from './ens-metadata';

const pool = getPostgresPool();

// ENS Name Wrapper contract address
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

/**
 * Resolve full ENS name details for the marketplace.
 *
 * Mirrors the behavior of `GET /api/v1/names/:name`:
 *  1. Look up the name (with vote/watchlist/listing enrichment) via buildNameResult.
 *  2. If not in the database, cold-import it from The Graph (upsert into ens_names)
 *     and re-run buildNameResult.
 *  3. If found, ensure metadata is fresh (refetches from The Graph when stale).
 *
 * Returns `null` when the name cannot be resolved at all - callers own the 404.
 *
 * @param name - Full ENS name (e.g., "vitalik.eth")
 * @param userId - Optional authenticated user ID for per-user fields (votes, watchlist)
 */
export async function resolveNameDetails(
  name: string,
  userId?: number
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
                  resolver {
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
          // Process text records - keep the last value for each key
          // If a record's most recent value is null/empty, it means the user unset it
          const metadata: EnsMetadata = {};
          if (domain.resolver?.textChangeds && Array.isArray(domain.resolver.textChangeds)) {
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

          // Process address records (multicoinAddrChangeds)
          if (domain.resolver?.multicoinAddrChangeds) {
            const chains = processAddressRecords(domain.resolver.multicoinAddrChangeds);
            if (chains.length > 0) {
              metadata.chains = chains;
            }
          }

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

          // Insert name into database
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
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
              ON CONFLICT (token_id)
              DO UPDATE SET
                name = EXCLUDED.name,
                owner_address = EXCLUDED.owner_address,
                expiry_date = EXCLUDED.expiry_date,
                registration_date = EXCLUDED.registration_date,
                metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
                metadata_updated_at = NOW(),
                updated_at = NOW()
              RETURNING id
            `;

          await pool.query(upsertQuery, [
            tokenId,
            domain.name,
            ownerAddress,
            expiryDate,
            registrationDate,
            JSON.stringify(metadata),
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

  // Check if metadata needs refresh (synchronous - fetches from Graph if stale)
  const { refreshed, metadata: freshMetadata } = await ensureMetadataFresh(
    nameResult.id,
    nameResult.name,
    nameResult.metadata_updated_at
  );

  if (refreshed) {
    // Merge fresh metadata into result. metadata can be null (e.g. the
    // unregistered placeholder); object spread of null is a no-op, but the
    // explicit ?? {} makes the intent clear.
    nameResult.metadata = { ...(nameResult.metadata ?? {}), ...freshMetadata };
    nameResult.metadata_updated_at = new Date();
  }

  return nameResult;
}
