import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse, type ENSName, config } from '../../../shared/src';
import { getBestListingForNFT, getBestOfferForNFT } from '../services/opensea';
import { ethers } from 'ethers';
import { optionalAuth } from '../middleware/auth';
import { trackNameView, getViewerIdentifier } from '../services/name-views';
import { cacheHandler } from '../middleware/cache';
import { fetchFreshMetadata } from '../services/ens-metadata';
import { resolveNameDetails } from '../services/name-details';
import { getNameRoles, type EnsRoles } from '../services/ens-roles';
import type { SearchResult } from '../utils/response-builder';

// ENS Name Wrapper contract address
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

// Name Wrapper ABI - just the ownerOf function we need
const NAME_WRAPPER_ABI = [
  'function ownerOf(uint256 id) view returns (address)'
];

// NOTE: The Graph has two expiry fields:
// - domain.expiryDate: includes 90-day grace period (END of grace period)
// - domain.registration.expiryDate: true expiry date (when name actually expires)
// We use domain.registration.expiryDate to get the correct expiry date.

const ListNamesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  owner: z.string().optional(),
  status: z.enum(['available', 'listed', 'expiring']).optional(),
  sort: z.enum(['name', 'price', 'expiry', 'created']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// FE-focused bundle endpoint: details + offers + roles in one response
const NameBundleParamsSchema = z.object({
  name: z.string().min(1).refine(
    (val) => val.endsWith('.eth') || val.includes('.'),
    { message: 'Must be a valid ENS name (e.g., name.eth)' }
  ),
});

const NameBundleQuerySchema = z.object({
  offersLimit: z.coerce.number().min(1).max(100).default(20),
  // Mirrors the SDK OfferStatus contract; the standalone offers endpoint does
  // not restrict status, so the bundle must accept the same set (incl. unfunded).
  offersStatus: z.enum(['pending', 'accepted', 'rejected', 'expired', 'unfunded']).default('pending'),
});

/**
 * Combined payload for the name page. Mirrors what the FE previously fetched via
 * three separate calls (name details, name offers, name roles) so the client can
 * seed the ['name','details'|'offers'|'roles', name] react-query caches from one
 * request.
 */
export interface NameBundleData {
  details: SearchResult;
  offers: any[];
  roles: EnsRoles | null;
}

export async function namesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * Get the actual owner of a wrapped ENS name by querying the Name Wrapper contract
   */
  async function getWrappedNameOwner(ensName: string): Promise<string | null> {
    try {
      const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
      const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

      // Compute namehash for the ENS name
      const namehash = ethers.namehash(ensName);

      // Call ownerOf on the Name Wrapper contract
      const owner = await nameWrapper.ownerOf(namehash);

      fastify.log.info({ ensName, namehash, owner }, 'Retrieved owner from Name Wrapper contract');

      return owner.toLowerCase();
    } catch (error: any) {
      fastify.log.error({ error, ensName }, 'Error querying Name Wrapper contract');
      return null;
    }
  }

  fastify.get('/', { preHandler: cacheHandler }, async (request, reply) => {
    const query = ListNamesQuerySchema.parse(request.query);
    const offset = (query.page - 1) * query.limit;

    let whereConditions = [];
    let params: any[] = [];
    let paramCount = 1;

    // Exclude names past grace period (90 days after expiry)
    // Allow: non-expired names, names in grace period, and subnames (no expiry date)
    whereConditions.push(`(en.expiry_date IS NULL OR en.expiry_date + INTERVAL '90 days' > NOW())`);

    if (query.owner) {
      whereConditions.push(`LOWER(en.owner_address) = LOWER($${paramCount})`);
      params.push(query.owner);
      paramCount++;
    }

    if (query.status === 'listed') {
      whereConditions.push(`
        EXISTS (
          SELECT 1 FROM listings
          WHERE listings.ens_name_id = en.id
          AND listings.status = 'active'
        )
      `);
    } else if (query.status === 'expiring') {
      whereConditions.push(`en.expiry_date < NOW() + INTERVAL '30 days'`);
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const orderByMap: Record<string, string> = {
      name: 'en.name',
      expiry: 'en.expiry_date',
      created: 'en.created_at',
      price: 'ap.price_wei::numeric',
    };

    const needsPriceCTE = query.sort === 'price';
    const nullsLast = needsPriceCTE ? ' NULLS LAST' : '';
    const orderBy = `${orderByMap[query.sort]} ${query.order.toUpperCase()}${nullsLast}`;

    const countQuery = `
      SELECT COUNT(*) FROM ens_names en ${whereClause}
    `;

    const priceCTE = needsPriceCTE ? `
      WITH active_prices AS (
        SELECT DISTINCT ON (ens_name_id) ens_name_id, price_wei
        FROM listings WHERE status = 'active'
        ORDER BY ens_name_id, created_at DESC
      )` : '';

    const priceJoin = needsPriceCTE ? `
      LEFT JOIN active_prices ap ON ap.ens_name_id = en.id` : '';

    const dataQuery = `
      ${priceCTE}
      SELECT en.*, COALESCE(listing_data.listings, '[]'::json) as listings
      FROM ens_names en
      ${priceJoin}
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', l.id,
            'price_wei', l.price_wei,
            'currency_address', l.currency_address,
            'status', l.status,
            'source', l.source,
            'expires_at', l.expires_at,
            'created_at', l.created_at
          ) ORDER BY l.created_at DESC
        ) as listings
        FROM listings l
        WHERE l.ens_name_id = en.id AND l.status = 'active'
      ) listing_data ON true
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    params.push(query.limit, offset);

    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, params.slice(0, -2)),
      pool.query(dataQuery, params),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / query.limit);

    const response: APIResponse<{
      names: ENSName[];
      pagination: any;
    }> = {
      success: true,
      data: {
        names: dataResult.rows,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
          hasNext: query.page < totalPages,
          hasPrev: query.page > 1,
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.get('/:name', { preHandler: optionalAuth }, async (request, reply) => {
    const { name } = request.params as { name: string };

    // Get user ID if authenticated
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    // Resolve full name details: DB lookup, The Graph cold-import fallback,
    // and metadata-freshness refresh (shared with the /:name/bundle endpoint)
    const nameResult = await resolveNameDetails(name, userId);

    if (!nameResult) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'NAME_NOT_FOUND',
          message: `ENS name "${name}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse = {
      success: true,
      data: nameResult,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    // Send response immediately
    reply.send(response);

    // Track view asynchronously (fire-and-forget) - for ALL users (authenticated + anonymous)
    if (nameResult.id) {
      const viewer = getViewerIdentifier(request);
      trackNameView(nameResult.id, viewer.identifier, viewer.type).catch((error) => {
        fastify.log.error(
          { error, ensNameId: nameResult.id, name, viewerType: viewer.type },
          'Failed to track name view asynchronously'
        );
      });
    }
  });

  /**
   * GET /api/v1/names/:name/bundle
   * FE-focused aggregate: returns name details, offers, and roles in a single
   * response so the name page can do one fetch instead of three. Behaves like
   * calling GET /names/:name, GET /offers/name/:name, and
   * GET /ens-roles/names/:name/roles individually.
   *
   * Not cached (mirrors GET /:name): optionalAuth produces per-user detail
   * fields, the handler tracks views, and metadata freshness must run per
   * request. Downstream load is absorbed by getNameRoles' in-memory cache and
   * the metadata DB TTL.
   */
  fastify.get('/:name/bundle', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      const { name } = NameBundleParamsSchema.parse(request.params);
      const query = NameBundleQuerySchema.parse(request.query);

      // Get user ID if authenticated
      const userId = request.user ? parseInt(request.user.sub) : undefined;

      // Kick off roles immediately: getNameRoles only needs `name` (a
      // cache-backed Graph call) and is independent of details, so overlap it
      // with the details resolution (a DB query + possible Graph fallback)
      // instead of starting it afterwards. The pre-attached .catch guarantees
      // this promise always settles, so the early 404 return below can leave
      // it running in the background without orphaning a rejection.
      const rolesPromise: Promise<EnsRoles | null> = getNameRoles(name).catch((error) => {
        fastify.log.error({ error, name }, 'Failed to fetch ENS roles for bundle');
        return null;
      });

      // details is authoritative: a 404 here matches the contract of all 3
      // source endpoints. Unexpected errors propagate to the global handler
      // (500), exactly like GET /:name.
      const details = await resolveNameDetails(name, userId);

      if (!details) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NAME_NOT_FOUND',
            message: `ENS name "${name}" not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // roles + offers are fault-isolated: a degraded dependency still returns
      // 200 with details (the FE already tolerates roles=null / offers=[]).
      // offers are keyed on the resolved ens_names.id (no second name lookup;
      // works for Graph cold-imported names; id===0 placeholder => []).
      const [roles, offers] = await Promise.all([
        rolesPromise,
        details.id
          ? pool
              .query(
                // offer_amount_wei is VARCHAR(78); cast to numeric so the
                // top-N sort is by value, not lexicographic ("9..." vs "10...").
                `SELECT o.*, e.name, e.token_id
                   FROM offers o
                   JOIN ens_names e ON o.ens_name_id = e.id
                  WHERE o.ens_name_id = $1 AND o.status = $2
                  ORDER BY o.offer_amount_wei::numeric DESC, o.created_at DESC
                  LIMIT $3`,
                [details.id, query.offersStatus, query.offersLimit]
              )
              .then((result) => result.rows)
              .catch((error) => {
                fastify.log.error({ error, name }, 'Failed to fetch offers for bundle');
                return [] as any[];
              })
          : Promise.resolve([] as any[]),
      ]);

      const response: APIResponse<NameBundleData> = {
        success: true,
        data: { details, offers, roles },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      // Send response immediately
      reply.send(response);

      // Track view asynchronously (fire-and-forget) - same as GET /:name
      if (details.id) {
        const viewer = getViewerIdentifier(request);
        trackNameView(details.id, viewer.identifier, viewer.type).catch((error) => {
          fastify.log.error(
            { error, ensNameId: details.id, name, viewerType: viewer.type },
            'Failed to track name view asynchronously'
          );
        });
      }
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request parameters',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      throw error;
    }
  });

  // Get metadata for a specific ENS name
  // Always fetches fresh data from The Graph, database sync happens async
  fastify.get('/:name/metadata', async (request, reply) => {
    const { name } = request.params as { name: string };

    // Query name to get ID
    const result = await pool.query(
      `SELECT id, name
       FROM ens_names
       WHERE LOWER(name) = LOWER($1)`,
      [name]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'NAME_NOT_FOUND',
          message: `ENS name "${name}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const row = result.rows[0];

    // Always fetch fresh metadata from The Graph
    // Database sync happens asynchronously to not slow down the response
    const { metadata, source } = await fetchFreshMetadata(row.id, row.name);

    return reply.send({
      success: true,
      data: {
        name: row.name,
        metadata,
        source,
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    });
  });

  // Legacy endpoint - keeping for backwards compatibility
  fastify.get('/:name/legacy', { preHandler: cacheHandler }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const query = `
      SELECT
        en.*,
        l.price_wei as listing_price,
        l.status as listing_status,
        l.expires_at as listing_expires_at,
        l.seller_address as listing_seller,
        l.order_data as listing_order_data,
        l.currency_address as listing_currency_address,
        l.source as listing_source,
        (
          SELECT COUNT(*) FROM offers
          WHERE offers.ens_name_id = en.id
          AND offers.status = 'pending'
        ) as active_offers_count,
        (
          SELECT json_agg(
            json_build_object(
              'transaction_hash', t.transaction_hash,
              'block_number', t.block_number,
              'from_address', t.from_address,
              'to_address', t.to_address,
              'price_wei', t.price_wei,
              'transaction_type', t.transaction_type,
              'timestamp', t.timestamp
            )
            ORDER BY t.timestamp DESC
          )
          FROM transactions t
          WHERE t.ens_name_id = en.id
          LIMIT 10
        ) as recent_transactions
      FROM ens_names en
      LEFT JOIN LATERAL (
        SELECT * FROM listings
        WHERE listings.ens_name_id = en.id
        AND listings.status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      ) l ON true
      WHERE LOWER(en.name) = LOWER($1)
    `;

    let result = await pool.query(query, [name]);

    // Check if owner is Name Wrapper contract and update if needed
    if (result.rows.length > 0 && result.rows[0].owner_address?.toLowerCase() === NAME_WRAPPER_ADDRESS) {
      fastify.log.info({ name }, 'Owner is Name Wrapper contract, fetching correct owner');

      try {
        // First try to get owner from The Graph (wrappedOwner)
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
                  wrappedOwner {
                    id
                  }
                  registrant {
                    id
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
        // Get owner based on registrant - if registrant is NameWrapper, use wrappedOwner
        let correctOwner: string | null = null;
        if (domain?.registrant?.id) {
          const registrant = domain.registrant.id.toLowerCase();
          if (registrant === NAME_WRAPPER_ADDRESS) {
            correctOwner = domain.wrappedOwner?.id || null;
          } else {
            correctOwner = registrant;
          }
        }

        // If no wrappedOwner or registrant, query the Name Wrapper contract directly
        if (!correctOwner) {
          fastify.log.info({ name }, 'No wrappedOwner or registrant found, querying Name Wrapper contract');
          correctOwner = await getWrappedNameOwner(name);
        }

        if (correctOwner && correctOwner.toLowerCase() !== NAME_WRAPPER_ADDRESS) {
          // Update the owner address in database
          await pool.query(
            'UPDATE ens_names SET owner_address = $1, updated_at = NOW() WHERE LOWER(name) = LOWER($2)',
            [correctOwner.toLowerCase(), name]
          );

          fastify.log.info({ name, correctOwner }, 'Updated owner from Name Wrapper to actual owner');

          // Re-query to get updated data
          result = await pool.query(query, [name]);
        }
      } catch (error) {
        fastify.log.error({ error, name }, 'Error updating Name Wrapper owner');
      }
    }

    // If name doesn't exist in database, try to fetch from The Graph
    if (result.rows.length === 0) {
      try {
        // Query The Graph for ENS name
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
                  owner {
                    id
                  }
                  registrant {
                    id
                  }
                  wrappedOwner {
                    id
                  }
                  resolver {
                    id
                    addr {
                      id
                    }
                  }
                  registration {
                    expiryDate
                    registrationDate
                  }
                  createdAt
                }
              }
            `,
            variables: {
              name: name.toLowerCase(),
            },
          }),
        });

        const graphData: any = await graphResponse.json();
        console.log('Graph response for', name, ':', JSON.stringify(graphData, null, 2));
        const domain = graphData?.data?.domains?.[0];

        if (!domain) {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'NAME_NOT_FOUND',
              message: `ENS name "${name}" not found on chain`,
            },
            meta: {
              timestamp: new Date().toISOString(),
            },
          });
        }

        // Convert labelhash to token ID
        const tokenId = domain.labelhash ? BigInt(domain.labelhash).toString() : null;

        if (!tokenId) {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'INVALID_NAME',
              message: `Could not determine token ID for "${name}"`,
            },
            meta: {
              timestamp: new Date().toISOString(),
            },
          });
        }

        // Insert or update name in database (handle placeholder records)
        const upsertQuery = `
          INSERT INTO ens_names (
            token_id,
            name,
            owner_address,
            expiry_date,
            registration_date,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (token_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            owner_address = EXCLUDED.owner_address,
            expiry_date = EXCLUDED.expiry_date,
            registration_date = EXCLUDED.registration_date,
            updated_at = NOW()
          RETURNING *
        `;

        // Get owner based on registrant - if registrant is NameWrapper, use wrappedOwner
        let ownerAddress: string | null = null;
        if (domain.registrant?.id) {
          const registrant = domain.registrant.id.toLowerCase();
          if (registrant === NAME_WRAPPER_ADDRESS) {
            ownerAddress = domain.wrappedOwner?.id?.toLowerCase() || null;
          } else {
            ownerAddress = registrant;
          }
        }
        const expiryDate = domain.registration?.expiryDate ? new Date(parseInt(domain.registration.expiryDate) * 1000) : null;
        const registrationDate = domain.registration?.registrationDate ? new Date(parseInt(domain.registration.registrationDate) * 1000) : (domain.createdAt ? new Date(parseInt(domain.createdAt) * 1000) : null);

        const upsertResult = await pool.query(upsertQuery, [
          tokenId,
          domain.name,
          ownerAddress,
          expiryDate,
          registrationDate,
        ]);

        // Query again to get full data with joins
        result = await pool.query(query, [name]);
      } catch (error) {
        console.error('Error fetching from The Graph:', error);
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NAME_NOT_FOUND',
            message: `ENS name "${name}" not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }
    }

    // Fetch OpenSea data in parallel
    const nameData = result.rows[0];
    const [openSeaListing, openSeaOffer] = await Promise.all([
      getBestListingForNFT(nameData.token_id),
      getBestOfferForNFT(nameData.token_id),
    ]);

    const response: APIResponse<ENSName> = {
      success: true,
      data: {
        ...nameData,
        opensea_listing: openSeaListing,
        opensea_offer: openSeaOffer,
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.get('/:name/history', { preHandler: cacheHandler }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { page = 1, limit = 20 } = request.query as any;
    const offset = (page - 1) * limit;

    const nameQuery = `SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)`;
    const nameResult = await pool.query(nameQuery, [name]);

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'NAME_NOT_FOUND',
          message: `ENS name "${name}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const ensNameId = nameResult.rows[0].id;

    const historyQuery = `
      SELECT * FROM transactions
      WHERE ens_name_id = $1
      ORDER BY timestamp DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) FROM transactions WHERE ens_name_id = $1
    `;

    const [historyResult, countResult] = await Promise.all([
      pool.query(historyQuery, [ensNameId, limit, offset]),
      pool.query(countQuery, [ensNameId]),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        transactions: historyResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}