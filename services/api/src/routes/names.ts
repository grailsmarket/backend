import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, ENSName } from '../../../shared/src';
import { searchNames } from '../services/search';
import { getBestListingForNFT, getBestOfferForNFT } from '../services/opensea';

const ListNamesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  owner: z.string().optional(),
  status: z.enum(['available', 'listed', 'expiring']).optional(),
  sort: z.enum(['name', 'price', 'expiry', 'created']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const SearchNamesQuerySchema = z.object({
  q: z.string().min(1),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  filters: z.object({
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),
    minLength: z.coerce.number().optional(),
    maxLength: z.coerce.number().optional(),
    hasNumbers: z.coerce.boolean().optional(),
    hasEmoji: z.coerce.boolean().optional(),
  }).optional(),
});

export async function namesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  fastify.get('/', async (request, reply) => {
    const query = ListNamesQuerySchema.parse(request.query);
    const offset = (query.page - 1) * query.limit;

    let whereConditions = [];
    let params: any[] = [];
    let paramCount = 1;

    if (query.owner) {
      whereConditions.push(`LOWER(owner_address) = LOWER($${paramCount})`);
      params.push(query.owner);
      paramCount++;
    }

    if (query.status === 'listed') {
      whereConditions.push(`
        EXISTS (
          SELECT 1 FROM listings
          WHERE listings.ens_name_id = ens_names.id
          AND listings.status = 'active'
        )
      `);
    } else if (query.status === 'expiring') {
      whereConditions.push(`expiry_date < NOW() + INTERVAL '30 days'`);
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const orderByMap = {
      name: 'name',
      expiry: 'expiry_date',
      created: 'created_at',
      price: `(
        SELECT price_wei FROM listings
        WHERE listings.ens_name_id = ens_names.id
        AND listings.status = 'active'
        LIMIT 1
      )`,
    };

    const orderBy = `${orderByMap[query.sort]} ${query.order.toUpperCase()}`;

    const countQuery = `
      SELECT COUNT(*) FROM ens_names ${whereClause}
    `;

    const dataQuery = `
      SELECT
        en.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', l.id,
              'price_wei', l.price_wei,
              'currency_address', l.currency_address,
              'status', l.status,
              'source', l.source,
              'expires_at', l.expires_at,
              'created_at', l.created_at
            ) ORDER BY l.created_at DESC
          ) FILTER (WHERE l.id IS NOT NULL),
          '[]'::json
        ) as listings
      FROM ens_names en
      LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
      ${whereClause}
      GROUP BY en.id
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

  fastify.get('/search', async (request, reply) => {
    const query = SearchNamesQuerySchema.parse(request.query);
    const results = await searchNames(query);

    const response: APIResponse = {
      success: true,
      data: results,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.get('/:name', async (request, reply) => {
    const { name } = request.params as { name: string };

    const query = `
      SELECT
        en.*,
        l.price_wei as listing_price,
        l.status as listing_status,
        l.expires_at as listing_expires_at,
        l.seller_address as listing_seller,
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

    // If name doesn't exist in database, try to fetch from The Graph
    if (result.rows.length === 0) {
      try {
        // Query The Graph for ENS name
        const graphResponse = await fetch('https://api.thegraph.com/subgraphs/name/ensdomains/ens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
                  expiryDate
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

        // For wrapped names, use wrappedOwner. Otherwise use registrant or owner
        const ownerAddress = domain.wrappedOwner?.id || domain.registrant?.id || domain.owner?.id;
        const expiryDate = domain.expiryDate ? new Date(parseInt(domain.expiryDate) * 1000) : null;
        const registrationDate = domain.createdAt ? new Date(parseInt(domain.createdAt) * 1000) : null;

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

  fastify.get('/:name/history', async (request, reply) => {
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