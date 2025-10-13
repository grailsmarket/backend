import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, getElasticsearchClient, APIResponse, Listing } from '../../../shared/src';

const CreateListingSchema = z.object({
  ensNameId: z.number(),
  sellerAddress: z.string(),
  priceWei: z.string(),
  currencyAddress: z.string().optional(),
  orderData: z.any(),
  expiresAt: z.string().optional(),
});

const UpdateListingSchema = z.object({
  priceWei: z.string().optional(),
  expiresAt: z.string().optional(),
});

const ListListingsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['active', 'sold', 'cancelled', 'expired']).optional(),
  seller: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  sort: z.enum(['price', 'created', 'expiry', 'name']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export async function listingsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const es = getElasticsearchClient();

  // GET all listings with filtering and pagination
  fastify.get('/', async (request, reply) => {
    const query = ListListingsQuerySchema.parse(request.query);
    fastify.log.info(`GET /listings - page=${query.page}, limit=${query.limit}, status=${query.status}`);
    const offset = (query.page - 1) * query.limit;

    let whereConditions: string[] = [];
    let params: any[] = [];
    let paramCount = 1;

    // Always include status filter, default to active if not specified
    const statusFilter = query.status || 'active';
    whereConditions.push(`l.status = $${paramCount}`);
    params.push(statusFilter);
    paramCount++;

    if (query.seller) {
      whereConditions.push(`l.seller_address = $${paramCount}`);
      params.push(query.seller.toLowerCase());
      paramCount++;
    }

    if (query.minPrice) {
      whereConditions.push(`CAST(l.price_wei AS NUMERIC) >= $${paramCount}`);
      params.push(query.minPrice);
      paramCount++;
    }

    if (query.maxPrice) {
      whereConditions.push(`CAST(l.price_wei AS NUMERIC) <= $${paramCount}`);
      params.push(query.maxPrice);
      paramCount++;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const orderByMap: { [key: string]: string } = {
      price: 'CAST(l.price_wei AS NUMERIC)',
      created: 'l.created_at',
      expiry: 'l.expires_at',
      name: 'en.name',
    };

    const orderBy = `${orderByMap[query.sort]} ${query.order.toUpperCase()} NULLS LAST`;

    // Count query
    const countQuery = `
      SELECT COUNT(*)
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      ${whereClause}
    `;

    // Data query with ENS name details
    const dataQuery = `
      SELECT
        l.*,
        en.name as ens_name,
        en.token_id,
        en.owner_address as current_owner,
        en.expiry_date as name_expiry_date,
        en.registration_date
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    params.push(query.limit, offset);

    try {
      const [countResult, dataResult] = await Promise.all([
        pool.query(countQuery, params.slice(0, -2)),
        pool.query(dataQuery, params),
      ]);

      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / query.limit);

      fastify.log.info(`Regular listings pagination: page=${query.page}, total=${total}, totalPages=${totalPages}, hasNext=${query.page < totalPages}`);

      const response: APIResponse<{
        listings: any[];
        pagination: any;
      }> = {
        success: true,
        data: {
          listings: dataResult.rows,
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
    } catch (error: any) {
      fastify.log.error('Error fetching listings:', error);
      throw error;
    }
  });

  // GET listing by ENS name (returns all active listings for the name)
  fastify.get('/name/:name', async (request, reply) => {
    const { name } = request.params as { name: string };

    const query = `
      SELECT
        l.*,
        en.name as ens_name,
        en.token_id,
        en.owner_address as current_owner,
        en.expiry_date as name_expiry_date,
        en.registration_date
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      WHERE LOWER(en.name) = LOWER($1)
      AND l.status = 'active'
      ORDER BY l.created_at DESC
    `;

    const result = await pool.query(query, [name]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: `No active listing found for "${name}"`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<any> = {
      success: true,
      data: result.rows,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // GET listing by ID
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const query = `
      SELECT
        l.*,
        en.name as ens_name,
        en.token_id,
        en.owner_address as current_owner,
        en.expiry_date as name_expiry_date,
        en.registration_date
      FROM listings l
      JOIN ens_names en ON l.ens_name_id = en.id
      WHERE l.id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: `Listing with ID "${id}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<any> = {
      success: true,
      data: result.rows[0],
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  // Search listings using Elasticsearch (with PostgreSQL fallback)
  fastify.get('/search', async (request, reply) => {
    const { q = '', page = 1, limit = 20, minPrice, maxPrice, minLength, maxLength, hasEmoji, hasNumbers, showAll = false } = request.query as any;
    const from = (page - 1) * limit;

    fastify.log.info(`Search request: q="${q}", page=${page}, limit=${limit}, minLength=${minLength}, maxLength=${maxLength}, hasEmoji=${hasEmoji}, hasNumbers=${hasNumbers}, showAll=${showAll}`);

    // Try Elasticsearch first, but fall back to PostgreSQL if it fails
    let usePostgresql = false;

    // Build Elasticsearch query
    const must: any[] = [];
    const filter: any[] = [];

    // Only filter by status if showAll is false
    if (!showAll || showAll === 'false') {
      filter.push({ term: { status: 'active' } });
    }

    if (q) {
      must.push({
        bool: {
          should: [
            // Exact match gets highest boost
            { match: { name: { query: q, boost: 10 } } },
            // Prefix match gets high boost
            { prefix: { name: { value: q, boost: 5 } } },
            // Ngram match for fuzzy matching (lower boost)
            { match: { 'name.ngram': { query: q, boost: 1 } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    if (minPrice || maxPrice) {
      const range: any = {};
      if (minPrice) range.gte = minPrice;
      if (maxPrice) range.lte = maxPrice;
      filter.push({ range: { price: range } });
    }

    // Add length filters using script query
    if (minLength || maxLength) {
      const scriptConditions: string[] = [];
      if (minLength) {
        scriptConditions.push(`doc['name.keyword'].value.replace('.eth', '').length() >= ${parseInt(minLength)}`);
      }
      if (maxLength) {
        scriptConditions.push(`doc['name.keyword'].value.replace('.eth', '').length() <= ${parseInt(maxLength)}`);
      }
      filter.push({
        script: {
          script: {
            source: scriptConditions.join(' && '),
            lang: 'painless',
          },
        },
      });
    }

    // Add emoji filter
    if (hasEmoji !== undefined) {
      filter.push({ term: { has_emoji: hasEmoji === 'true' || hasEmoji === true } });
    }

    // Add numbers filter
    if (hasNumbers !== undefined) {
      filter.push({ term: { has_numbers: hasNumbers === 'true' || hasNumbers === true } });
    }

    const esQuery = {
      index: 'ens_names',
      body: {
        query: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter,
          },
        },
        min_score: q ? 20.0 : undefined, // Only filter by score if there's a text query
        from,
        size: limit,
        sort: q ? [
          { _score: { order: 'desc' } }, // Sort by relevance first when searching
          { listing_created_at: { order: 'desc' } },
        ] : [
          { listing_created_at: { order: 'desc' } }, // Sort by date when not searching
        ],
      },
    };

    try {
      const esResult = await es.search(esQuery);

      fastify.log.info('Elasticsearch returned results');

      // Log scores for debugging
      if (q && esResult.hits.hits.length > 0) {
        const scores = esResult.hits.hits.map((hit: any) => ({ name: hit._source.name, score: hit._score }));
        fastify.log.info(`ES scores sample (first 5): ${JSON.stringify(scores.slice(0, 5))}`);
        fastify.log.info(`ES scores sample (last 5): ${JSON.stringify(scores.slice(-5))}`);
      }

      // Extract ENS names from Elasticsearch results
      const ensNames = esResult.hits.hits.map((hit: any) => hit._source.name);

      if (ensNames.length === 0) {
        fastify.log.info('No ES results found');
        return reply.send({
          success: true,
          data: {
            listings: [],
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: 0,
              totalPages: 0,
              hasNext: false,
              hasPrev: false,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        });
      }

      // Fetch full listing details from PostgreSQL
      // Preserve Elasticsearch order using CASE statement
      const placeholders = ensNames.map((_: any, i: number) => `$${i + 1}`).join(',');
      const orderCases = ensNames.map((name: string, i: number) => `WHEN LOWER(en.name) = $${i + 1} THEN ${i}`).join(' ');

      // Build query based on showAll flag
      const listingQuery = showAll === true || showAll === 'true' ? `
        SELECT
          l.id,
          l.price_wei,
          l.status,
          l.created_at,
          l.order_hash,
          l.order_data,
          l.seller_address,
          en.name as ens_name,
          en.token_id,
          en.owner_address as current_owner,
          en.expiry_date as name_expiry_date,
          en.registration_date
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
        WHERE LOWER(en.name) IN (${placeholders})
        ORDER BY CASE ${orderCases} END
      ` : `
        SELECT
          l.*,
          en.name as ens_name,
          en.token_id,
          en.owner_address as current_owner,
          en.expiry_date as name_expiry_date,
          en.registration_date
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE LOWER(en.name) IN (${placeholders})
        AND l.status = 'active'
        ORDER BY CASE ${orderCases} END
      `;

      const listingResult = await pool.query(
        listingQuery,
        ensNames.map((name: string) => name.toLowerCase())
      );

      const currentPage = parseInt(page);
      const pageLimit = parseInt(limit);
      const total = typeof esResult.hits.total === 'object' ? esResult.hits.total.value : (esResult.hits.total || 0);
      const totalPages = Math.ceil(total / pageLimit);

      fastify.log.info(`ES search pagination: page=${currentPage}, total=${total}, totalPages=${totalPages}, hasNext=${currentPage < totalPages}`);

      const response: APIResponse<{
        listings: any[];
        pagination: any;
      }> = {
        success: true,
        data: {
          listings: listingResult.rows,
          pagination: {
            page: currentPage,
            limit: pageLimit,
            total,
            totalPages,
            hasNext: currentPage < totalPages,
            hasPrev: currentPage > 1,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.warn('Elasticsearch search failed, falling back to PostgreSQL:', error.message);

      // Fallback to PostgreSQL-based search
      const includeAllNames = showAll === true || showAll === 'true';
      let whereConditions: string[] = [];
      let params: any[] = [];
      let paramCount = 1;

      // Only filter by status if not showing all names
      if (!includeAllNames) {
        whereConditions.push(`l.status = $${paramCount}`);
        params.push('active');
        paramCount++;
      }

      fastify.log.info(`Using PostgreSQL fallback, query="${q}", showAll=${includeAllNames}`);

      // Add name search condition
      if (q && q.trim()) {
        const searchPattern = `%${q.toLowerCase()}%`;
        whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
        params.push(searchPattern);
        paramCount++;
        fastify.log.info(`Added name search condition: ${searchPattern}`);
      }

      // Add price filters (only for listings)
      if (minPrice && !includeAllNames) {
        whereConditions.push(`CAST(l.price_wei AS NUMERIC) >= $${paramCount}`);
        params.push(minPrice);
        paramCount++;
      }

      if (maxPrice && !includeAllNames) {
        whereConditions.push(`CAST(l.price_wei AS NUMERIC) <= $${paramCount}`);
        params.push(maxPrice);
        paramCount++;
      }

      // Add length filters
      if (minLength) {
        whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) >= $${paramCount}`);
        params.push(parseInt(minLength));
        paramCount++;
      }

      if (maxLength) {
        whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) <= $${paramCount}`);
        params.push(parseInt(maxLength));
        paramCount++;
      }

      // Add emoji filter
      if (hasEmoji !== undefined) {
        whereConditions.push(`en.has_emoji = $${paramCount}`);
        params.push(hasEmoji === 'true' || hasEmoji === true);
        paramCount++;
      }

      // Add numbers filter
      if (hasNumbers !== undefined) {
        whereConditions.push(`en.has_numbers = $${paramCount}`);
        params.push(hasNumbers === 'true' || hasNumbers === true);
        paramCount++;
      }

      const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

      // Build queries based on showAll
      const countQuery = includeAllNames ? `
        SELECT COUNT(*)
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
        WHERE ${whereClause}
      ` : `
        SELECT COUNT(*)
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE ${whereClause}
      `;

      const dataQuery = includeAllNames ? `
        SELECT
          l.id,
          l.price_wei,
          l.status,
          l.created_at,
          l.order_hash,
          l.order_data,
          l.seller_address,
          en.name as ens_name,
          en.token_id,
          en.owner_address as current_owner,
          en.expiry_date as name_expiry_date,
          en.registration_date
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
        WHERE ${whereClause}
        ORDER BY en.name ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      ` : `
        SELECT
          l.*,
          en.name as ens_name,
          en.token_id,
          en.owner_address as current_owner,
          en.expiry_date as name_expiry_date,
          en.registration_date
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE ${whereClause}
        ORDER BY l.created_at DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `;

      params.push(limit, from);

      try {
        const [countResult, dataResult] = await Promise.all([
          pool.query(countQuery, params.slice(0, -2)),
          pool.query(dataQuery, params),
        ]);

        const total = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(total / limit);
        const currentPage = parseInt(page);

        fastify.log.info(`Pagination: page=${currentPage}, limit=${limit}, total=${total}, totalPages=${totalPages}, hasNext=${currentPage < totalPages}`);

        return reply.send({
          success: true,
          data: {
            listings: dataResult.rows,
            pagination: {
              page: currentPage,
              limit: parseInt(limit),
              total,
              totalPages,
              hasNext: currentPage < totalPages,
              hasPrev: currentPage > 1,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        });
      } catch (pgError: any) {
        fastify.log.error('PostgreSQL fallback search also failed:', pgError);
        return reply.status(500).send({
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: 'Search service temporarily unavailable',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  });

  fastify.post('/', async (request, reply) => {
    const body = CreateListingSchema.parse(request.body);

    const query = `
      INSERT INTO listings (
        ens_name_id,
        seller_address,
        price_wei,
        currency_address,
        order_data,
        status,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [
        body.ensNameId,
        body.sellerAddress.toLowerCase(), // Normalize to lowercase
        body.priceWei,
        body.currencyAddress?.toLowerCase() || '0x0000000000000000000000000000000000000000',
        JSON.stringify(body.orderData),
        body.expiresAt ? new Date(body.expiresAt) : null,
      ]);

      const listing = result.rows[0];

      // Publish queue jobs for new listing
      try {
        const { getQueueClient, QUEUE_NAMES } = await import('../queue');
        const boss = await getQueueClient();

        // 1. Schedule expiry job if expires_at is set
        if (listing.expires_at) {
          await boss.send(
            QUEUE_NAMES.EXPIRE_ORDERS,
            { type: 'listing', id: listing.id },
            { startAfter: new Date(listing.expires_at) }
          );
          fastify.log.info({ listingId: listing.id, expiresAt: listing.expires_at }, 'Scheduled expiry job');
        }

        // 2. Trigger immediate ENS metadata sync
        const ensNameResult = await pool.query(
          'SELECT token_id FROM ens_names WHERE id = $1',
          [body.ensNameId]
        );

        if (ensNameResult.rows.length > 0) {
          await boss.send(QUEUE_NAMES.SYNC_ENS_DATA, {
            ensNameId: body.ensNameId,
            nameHash: ensNameResult.rows[0].token_id,
            priority: 'high',
          });
          fastify.log.info({ ensNameId: body.ensNameId }, 'Scheduled ENS sync job');
        }
      } catch (queueError) {
        // Don't fail the request if queue publishing fails
        fastify.log.error({ error: queueError }, 'Failed to publish queue jobs for listing');
      }

      const response: APIResponse<Listing> = {
        success: true,
        data: listing,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.status(201).send(response);
    } catch (error: any) {
      if (error.code === '23503') {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: 'ENS name not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      throw error;
    }
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateListingSchema.parse(request.body);

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (body.priceWei !== undefined) {
      updates.push(`price_wei = $${paramCount}`);
      values.push(body.priceWei);
      paramCount++;
    }

    if (body.expiresAt !== undefined) {
      updates.push(`expires_at = $${paramCount}`);
      values.push(new Date(body.expiresAt));
      paramCount++;
    }

    if (updates.length === 0) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'NO_UPDATES',
          message: 'No fields to update',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    values.push(id);

    const query = `
      UPDATE listings
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramCount}
      AND status = 'active'
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: 'Active listing not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<Listing> = {
      success: true,
      data: result.rows[0],
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const query = `
      UPDATE listings
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
      AND status = 'active'
      RETURNING *
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'LISTING_NOT_FOUND',
          message: 'Active listing not found',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse = {
      success: true,
      data: {
        message: 'Listing cancelled successfully',
        listing: result.rows[0],
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}