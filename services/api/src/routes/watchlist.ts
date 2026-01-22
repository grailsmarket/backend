import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, getElasticsearchClient } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { buildSearchResults } from '../utils/response-builder';
import { buildESQuery, buildESFilters, buildESSort, calculateMinScore, ESFilterOptions } from '../utils/elasticsearch-filters';
import { stringify } from 'csv-stringify';

const AddToWatchlistSchema = z.object({
  ensName: z.string().min(1),
  notifyOnSale: z.boolean().default(true),
  notifyOnOffer: z.boolean().default(true),
  notifyOnListing: z.boolean().default(true),
  notifyOnPriceChange: z.boolean().default(false),
});

const UpdateWatchlistSchema = z.object({
  notifyOnSale: z.boolean().optional(),
  notifyOnOffer: z.boolean().optional(),
  notifyOnListing: z.boolean().optional(),
  notifyOnPriceChange: z.boolean().optional(),
});

const WatchlistQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// Helper to properly parse boolean strings (unlike z.coerce.boolean which treats "false" as true)
const booleanString = z.union([z.boolean(), z.string()]).optional();

const SearchWatchlistQuerySchema = z.object({
  q: z.string().default('*'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['price', 'expiry_date', 'registration_date', 'last_sale_date',
    'last_sale_price', 'character_count', 'watchers_count', 'alphabetical']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  filters: z.object({
    // Price filters
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),

    // Length filters
    minLength: z.coerce.number().optional(),
    maxLength: z.coerce.number().optional(),

    // Legacy character filters (use string to let buildESFilters handle 'true'/'false')
    hasNumbers: booleanString,
    hasEmoji: booleanString,

    // Tri-state character filters
    digits: z.enum(['include', 'exclude', 'only']).optional(),
    letters: z.enum(['include', 'exclude', 'only']).optional(),
    emoji: z.enum(['include', 'exclude', 'only']).optional(),
    repeatingChars: z.enum(['include', 'exclude', 'only']).optional(),

    // String pattern filters
    contains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    doesNotContain: z.string().optional(),
    doesNotStartWith: z.string().optional(),
    doesNotEndWith: z.string().optional(),

    // Listing/market filters (use string to let buildESFilters handle 'true'/'false')
    listed: booleanString,
    hasOffer: booleanString,
    marketplace: z.enum(['grails', 'opensea', 'all']).optional(),

    // Club filters
    clubs: z.array(z.string()).optional(),
    inAnyClub: booleanString,

    // Unified status filter
    status: z.enum(['registered', 'grace', 'premium', 'available', 'all']).optional(),

    // Legacy expiration filters (use string to let buildESFilters handle 'true'/'false')
    isExpired: booleanString,
    isGracePeriod: booleanString,
    isPremiumPeriod: booleanString,
    expiringWithinDays: z.coerce.number().optional(),
    includeExpired: booleanString,

    // Sale history filters
    hasSales: booleanString,
    lastSoldAfter: z.string().optional(),
    lastSoldBefore: z.string().optional(),
    minDaysSinceLastSale: z.coerce.number().optional(),
    maxDaysSinceLastSale: z.coerce.number().optional(),
  }).optional(),
});

export async function watchlistRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/watchlist
   * Get user's watchlist
   */
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { page, limit } = WatchlistQuerySchema.parse(request.query);
      const userId = parseInt(request.user.sub);
      const offset = (page - 1) * limit;

      // Get total count
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM watchlist WHERE user_id = $1',
        [userId]
      );

      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / limit);

      // Get watchlist with ENS name details
      const watchlistResult = await pool.query(
        `SELECT
          w.*,
          en.name,
          en.token_id,
          en.owner_address,
          en.expiry_date,
          EXISTS (
            SELECT 1 FROM listings l
            WHERE l.ens_name_id = w.ens_name_id AND l.status = 'active'
          ) as has_active_listing,
          (
            SELECT json_build_object(
              'id', l.id,
              'price_wei', l.price_wei,
              'currency_address', l.currency_address,
              'source', l.source,
              'created_at', l.created_at
            )
            FROM listings l
            WHERE l.ens_name_id = w.ens_name_id AND l.status = 'active'
            ORDER BY l.created_at DESC
            LIMIT 1
          ) as active_listing
        FROM watchlist w
        JOIN ens_names en ON w.ens_name_id = en.id
        WHERE w.user_id = $1
        ORDER BY w.added_at DESC
        LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      const response: APIResponse = {
        success: true,
        data: {
          watchlist: watchlistResult.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            ensNameId: row.ens_name_id,
            ensName: row.name,
            notifyOnSale: row.notify_on_sale,
            notifyOnOffer: row.notify_on_offer,
            notifyOnListing: row.notify_on_listing,
            notifyOnPriceChange: row.notify_on_price_change,
            addedAt: row.added_at,
            nameData: {
              name: row.name,
              tokenId: row.token_id,
              ownerAddress: row.owner_address,
              expiryDate: row.expiry_date,
              hasActiveListing: row.has_active_listing,
              activeListing: row.active_listing,
            },
          })),
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
    } catch (error: any) {
      fastify.log.error('Error fetching watchlist:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * POST /api/v1/watchlist
   * Add ENS name to watchlist
   */
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const data = AddToWatchlistSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      // Resolve ENS name to ens_name_id
      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)',
        [data.ensName]
      );

      if (ensResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: `ENS name "${data.ensName}" not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const ensNameId = ensResult.rows[0].id;

      // Insert or return existing watchlist entry
      const watchlistResult = await pool.query(
        `INSERT INTO watchlist (
          user_id, ens_name_id, notify_on_sale, notify_on_offer,
          notify_on_listing, notify_on_price_change
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, ens_name_id)
        DO UPDATE SET
          notify_on_sale = EXCLUDED.notify_on_sale,
          notify_on_offer = EXCLUDED.notify_on_offer,
          notify_on_listing = EXCLUDED.notify_on_listing,
          notify_on_price_change = EXCLUDED.notify_on_price_change
        RETURNING *`,
        [
          userId,
          ensNameId,
          data.notifyOnSale,
          data.notifyOnOffer,
          data.notifyOnListing,
          data.notifyOnPriceChange,
        ]
      );

      const watchlist = watchlistResult.rows[0];

      const response: APIResponse = {
        success: true,
        data: {
          id: watchlist.id,
          userId: watchlist.user_id,
          ensNameId: watchlist.ens_name_id,
          ensName: data.ensName,
          notifyOnSale: watchlist.notify_on_sale,
          notifyOnOffer: watchlist.notify_on_offer,
          notifyOnListing: watchlist.notify_on_listing,
          notifyOnPriceChange: watchlist.notify_on_price_change,
          addedAt: watchlist.added_at,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error adding to watchlist:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to add to watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * DELETE /api/v1/watchlist/:id
   * Remove ENS name from watchlist
   */
  fastify.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { id } = request.params as { id: string };
      const userId = parseInt(request.user.sub);

      // Verify watchlist entry belongs to user
      const checkResult = await pool.query(
        'SELECT user_id FROM watchlist WHERE id = $1',
        [parseInt(id)]
      );

      if (checkResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Watchlist entry not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (checkResult.rows[0].user_id !== userId) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'This watchlist entry belongs to another user',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Delete entry
      await pool.query('DELETE FROM watchlist WHERE id = $1', [parseInt(id)]);

      const response: APIResponse = {
        success: true,
        data: {
          message: 'Removed from watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error removing from watchlist:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to remove from watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * PATCH /api/v1/watchlist/:id
   * Update watchlist notification preferences
   */
  fastify.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { id } = request.params as { id: string };
      const updates = UpdateWatchlistSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      // Verify watchlist entry belongs to user
      const checkResult = await pool.query(
        'SELECT user_id FROM watchlist WHERE id = $1',
        [parseInt(id)]
      );

      if (checkResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Watchlist entry not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (checkResult.rows[0].user_id !== userId) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'This watchlist entry belongs to another user',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Build dynamic UPDATE query
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (updates.notifyOnSale !== undefined) {
        updateFields.push(`notify_on_sale = $${paramCount}`);
        values.push(updates.notifyOnSale);
        paramCount++;
      }

      if (updates.notifyOnOffer !== undefined) {
        updateFields.push(`notify_on_offer = $${paramCount}`);
        values.push(updates.notifyOnOffer);
        paramCount++;
      }

      if (updates.notifyOnListing !== undefined) {
        updateFields.push(`notify_on_listing = $${paramCount}`);
        values.push(updates.notifyOnListing);
        paramCount++;
      }

      if (updates.notifyOnPriceChange !== undefined) {
        updateFields.push(`notify_on_price_change = $${paramCount}`);
        values.push(updates.notifyOnPriceChange);
        paramCount++;
      }

      if (updateFields.length === 0) {
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

      values.push(parseInt(id));

      const query = `
        UPDATE watchlist
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await pool.query(query, values);
      const watchlist = result.rows[0];

      const response: APIResponse = {
        success: true,
        data: {
          id: watchlist.id,
          notifyOnSale: watchlist.notify_on_sale,
          notifyOnOffer: watchlist.notify_on_offer,
          notifyOnListing: watchlist.notify_on_listing,
          notifyOnPriceChange: watchlist.notify_on_price_change,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error updating watchlist:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/watchlist/check/:name
   * Check if a specific ENS name is in the user's watchlist
   */
  fastify.get('/check/:name', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { name } = request.params as { name: string };
      const userId = parseInt(request.user.sub);

      // Look up the ENS name and check if it's in the watchlist
      const result = await pool.query(
        `SELECT
          w.id,
          w.notify_on_sale,
          w.notify_on_offer,
          w.notify_on_listing,
          w.notify_on_price_change,
          w.added_at,
          en.id as ens_name_id,
          en.name
        FROM ens_names en
        LEFT JOIN watchlist w ON w.ens_name_id = en.id AND w.user_id = $1
        WHERE LOWER(en.name) = LOWER($2)`,
        [userId, name]
      );

      if (result.rows.length === 0) {
        // ENS name doesn't exist in database
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: `ENS name "${name}" not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const row = result.rows[0];
      const isWatching = row.id !== null;

      const response: APIResponse = {
        success: true,
        data: {
          isWatching,
          watchlistEntry: isWatching ? {
            id: row.id,
            ensNameId: row.ens_name_id,
            ensName: row.name,
            notifyOnSale: row.notify_on_sale,
            notifyOnOffer: row.notify_on_offer,
            notifyOnListing: row.notify_on_listing,
            notifyOnPriceChange: row.notify_on_price_change,
            addedAt: row.added_at,
          } : null,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error checking watchlist:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to check watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/watchlist/search
   * Search and filter user's watchlist using Elasticsearch
   */
  fastify.get('/search', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const userId = parseInt(request.user.sub);

      // Transform flat query params into nested structure (same as /names/search)
      const rawQuery = request.query as any;
      const transformedQuery: any = {
        q: rawQuery.q,
        page: rawQuery.page,
        limit: rawQuery.limit,
        sortBy: rawQuery.sortBy,
        sortOrder: rawQuery.sortOrder,
        filters: {},
      };

      // Parse filters from bracket notation
      for (const key in rawQuery) {
        if (key.startsWith('filters[')) {
          const match = key.match(/filters\[([^\]]+)\](\[\])?/);
          if (match) {
            const filterName = match[1];
            const isArray = match[2] === '[]';

            if (isArray) {
              if (!transformedQuery.filters[filterName]) {
                transformedQuery.filters[filterName] = [];
              }
              const value = rawQuery[key];
              if (Array.isArray(value)) {
                transformedQuery.filters[filterName].push(...value);
              } else {
                transformedQuery.filters[filterName].push(value);
              }
            } else {
              transformedQuery.filters[filterName] = rawQuery[key];
            }
          }
        }
      }

      const query = SearchWatchlistQuerySchema.parse(transformedQuery);

      // Get user's watchlist ENS names
      const watchlistResult = await pool.query(
        `SELECT en.name
         FROM watchlist w
         JOIN ens_names en ON w.ens_name_id = en.id
         WHERE w.user_id = $1`,
        [userId]
      );

      if (watchlistResult.rows.length === 0) {
        // User has no watchlist items
        return reply.send({
          success: true,
          data: {
            results: [],
            pagination: {
              page: query.page,
              limit: query.limit,
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

      const watchlistNames = watchlistResult.rows.map(row => row.name);

      // Search within watchlist using Elasticsearch with full filter support
      const esClient = getElasticsearchClient();
      const filters = query.filters || {};
      const searchQuery = buildESQuery({
        q: query.q === '*' ? undefined : query.q,
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        ensNames: watchlistNames, // Restrict search to watchlist items only
        // All supported filters
        minPrice: filters.minPrice,
        maxPrice: filters.maxPrice,
        minLength: filters.minLength,
        maxLength: filters.maxLength,
        hasNumbers: filters.hasNumbers,
        hasEmoji: filters.hasEmoji,
        digits: filters.digits,
        letters: filters.letters,
        emoji: filters.emoji,
        repeatingChars: filters.repeatingChars,
        contains: filters.contains,
        startsWith: filters.startsWith,
        endsWith: filters.endsWith,
        doesNotContain: filters.doesNotContain,
        doesNotStartWith: filters.doesNotStartWith,
        doesNotEndWith: filters.doesNotEndWith,
        listed: filters.listed,
        hasOffer: filters.hasOffer,
        clubs: filters.clubs,
        inAnyClub: filters.inAnyClub,
        status: filters.status,
        isExpired: filters.isExpired,
        isGracePeriod: filters.isGracePeriod,
        isPremiumPeriod: filters.isPremiumPeriod,
        expiringWithinDays: filters.expiringWithinDays,
        // Default to including expired names in watchlist (user explicitly added them)
        includeExpired: filters.includeExpired ?? true,
        hasSales: filters.hasSales,
        lastSoldAfter: filters.lastSoldAfter,
        lastSoldBefore: filters.lastSoldBefore,
        minDaysSinceLastSale: filters.minDaysSinceLastSale,
        maxDaysSinceLastSale: filters.maxDaysSinceLastSale,
      });

      const esResponse = await esClient.search(searchQuery);
      const hits = esResponse.hits.hits;
      const total = typeof esResponse.hits.total === 'number'
        ? esResponse.hits.total
        : esResponse.hits.total?.value ?? 0;

      // Extract names from Elasticsearch results
      const resultNames = hits.map((hit: any) => hit._source.name);

      // Build results with watchlist metadata
      const results = await buildSearchResults(resultNames, userId);

      // Fetch watchlist preferences for each result
      const watchlistPrefsResult = await pool.query(
        `SELECT
          w.ens_name_id,
          w.notify_on_sale,
          w.notify_on_offer,
          w.notify_on_listing,
          w.notify_on_price_change,
          w.id as watchlist_id,
          w.added_at,
          en.name
        FROM watchlist w
        JOIN ens_names en ON w.ens_name_id = en.id
        WHERE w.user_id = $1 AND en.name = ANY($2)`,
        [userId, resultNames]
      );

      // Create a map of name -> watchlist data
      const watchlistMap = new Map();
      watchlistPrefsResult.rows.forEach(row => {
        watchlistMap.set(row.name, {
          watchlistId: row.watchlist_id,
          notifyOnSale: row.notify_on_sale,
          notifyOnOffer: row.notify_on_offer,
          notifyOnListing: row.notify_on_listing,
          notifyOnPriceChange: row.notify_on_price_change,
          addedAt: row.added_at,
        });
      });

      // Merge watchlist data with search results
      const enrichedResults = results.map(result => {
        const watchlistData = watchlistMap.get(result.name);
        return {
          ...result,
          watchlist: watchlistData || null,
        };
      });

      const totalPages = Math.ceil(total / query.limit);
      const response: APIResponse = {
        success: true,
        data: {
          results: enrichedResults,
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
      fastify.log.error('Error searching watchlist:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to search watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/watchlist/export
   * Export user's watchlist as CSV
   */
  fastify.get('/export', { preHandler: requireAuth }, async (request, reply) => {
    const MAX_EXPORT_ROWS = 10000;
    const BATCH_SIZE = 1000;

    const CSV_HEADERS = [
      'id',
      'name',
      'token_id',
      'owner_address',
      'expiry_date',
      'status',
      'list_price',
      'registration_date',
      'clubs',
      'view_count',
    ];

    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const userId = parseInt(request.user.sub);
      const rawQuery = request.query as any;
      const filename = rawQuery.filename || 'watchlist-export';

      // Transform flat query params into nested structure (same as /search)
      const transformedQuery: any = {
        q: rawQuery.q,
        sortBy: rawQuery.sortBy,
        sortOrder: rawQuery.sortOrder,
        filters: {},
      };

      // Parse filters from bracket notation
      for (const key in rawQuery) {
        if (key.startsWith('filters[')) {
          const match = key.match(/filters\[([^\]]+)\](\[\])?/);
          if (match) {
            const filterName = match[1];
            const isArray = match[2] === '[]';

            if (isArray) {
              if (!transformedQuery.filters[filterName]) {
                transformedQuery.filters[filterName] = [];
              }
              const value = rawQuery[key];
              if (Array.isArray(value)) {
                transformedQuery.filters[filterName].push(...value);
              } else {
                transformedQuery.filters[filterName].push(value);
              }
            } else {
              transformedQuery.filters[filterName] = rawQuery[key];
            }
          }
        }
      }

      const filters = transformedQuery.filters || {};
      const { sortBy, sortOrder, q } = transformedQuery;

      fastify.log.info(`Watchlist export request: q="${q}", sortBy=${sortBy}, filters=${JSON.stringify(filters)}`);

      // Get user's watchlist ENS names
      const watchlistResult = await pool.query(
        `SELECT en.name
         FROM watchlist w
         JOIN ens_names en ON w.ens_name_id = en.id
         WHERE w.user_id = $1`,
        [userId]
      );

      if (watchlistResult.rows.length === 0) {
        // Return empty CSV with headers
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return reply.send(CSV_HEADERS.join(',') + '\n');
      }

      const watchlistNames = watchlistResult.rows.map(row => row.name);

      // Build ES filter options
      const esOptions: ESFilterOptions = {
        q: q === '*' ? undefined : q,
        sortBy,
        sortOrder,
        ensNames: watchlistNames, // Restrict to watchlist items
        minPrice: filters.minPrice,
        maxPrice: filters.maxPrice,
        minLength: filters.minLength,
        maxLength: filters.maxLength,
        hasNumbers: filters.hasNumbers,
        hasEmoji: filters.hasEmoji,
        digits: filters.digits,
        letters: filters.letters,
        emoji: filters.emoji,
        repeatingChars: filters.repeatingChars,
        contains: filters.contains,
        startsWith: filters.startsWith,
        endsWith: filters.endsWith,
        doesNotContain: filters.doesNotContain,
        doesNotStartWith: filters.doesNotStartWith,
        doesNotEndWith: filters.doesNotEndWith,
        listed: filters.listed,
        hasOffer: filters.hasOffer,
        clubs: filters.clubs,
        inAnyClub: filters.inAnyClub,
        status: filters.status,
        isExpired: filters.isExpired,
        isGracePeriod: filters.isGracePeriod,
        isPremiumPeriod: filters.isPremiumPeriod,
        expiringWithinDays: filters.expiringWithinDays,
        includeExpired: filters.includeExpired ?? true,
        hasSales: filters.hasSales,
        lastSoldAfter: filters.lastSoldAfter,
        lastSoldBefore: filters.lastSoldBefore,
        minDaysSinceLastSale: filters.minDaysSinceLastSale,
        maxDaysSinceLastSale: filters.maxDaysSinceLastSale,
      };

      // Fetch names from Elasticsearch using search_after for large exports
      const esClient = getElasticsearchClient();
      const { must, filter } = buildESFilters(esOptions);
      const sort = buildESSort({
        sortBy: esOptions.sortBy,
        sortOrder: esOptions.sortOrder,
        q: esOptions.q,
      });
      const minScore = calculateMinScore(esOptions.q);

      // Add tie-breaker for search_after
      const sortWithTieBreaker = [...sort];
      if (!sortWithTieBreaker.some((s: any) => s['name.keyword'])) {
        sortWithTieBreaker.push({ 'name.keyword': { order: 'asc' } });
      }

      const allNames: string[] = [];
      let searchAfter: any[] | undefined;

      while (allNames.length < MAX_EXPORT_ROWS) {
        const remaining = MAX_EXPORT_ROWS - allNames.length;
        const batchSize = Math.min(BATCH_SIZE, remaining);

        const esQuery: any = {
          index: 'ens_names',
          body: {
            query: {
              bool: {
                must: must.length > 0 ? must : [{ match_all: {} }],
                filter,
              },
            },
            size: batchSize,
            sort: sortWithTieBreaker,
          },
        };

        if (minScore !== undefined) {
          esQuery.body.min_score = minScore;
        }

        if (searchAfter) {
          esQuery.body.search_after = searchAfter;
        }

        const esResult = await esClient.search(esQuery);
        const hits = esResult.hits.hits;

        if (hits.length === 0) {
          break;
        }

        const names = hits
          .map((hit: any) => hit._source.name)
          .filter((name: string) => name && !name.startsWith('token-') && !name.startsWith('['));

        allNames.push(...names);
        searchAfter = hits[hits.length - 1].sort;

        fastify.log.info(`Watchlist export: fetched ${names.length} names (total: ${allNames.length})`);

        if (hits.length < batchSize) {
          break;
        }
      }

      const exportNames = allNames.slice(0, MAX_EXPORT_ROWS);

      if (exportNames.length === 0) {
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return reply.send(CSV_HEADERS.join(',') + '\n');
      }

      // Fetch export data from PostgreSQL
      const placeholders = exportNames.map((_, i) => `$${i + 1}`).join(',');
      const query = `
        SELECT
          en.id,
          en.name,
          en.token_id,
          en.owner_address,
          en.expiry_date,
          en.registration_date,
          en.clubs,
          COALESCE(en.view_count, 0) as view_count,
          MIN(CASE WHEN l.status = 'active' THEN l.price_wei END) as list_price,
          CASE
            WHEN en.expiry_date IS NULL THEN 'registered'
            WHEN en.expiry_date > NOW() THEN 'registered'
            WHEN en.expiry_date > NOW() - INTERVAL '90 days' THEN 'grace'
            WHEN en.expiry_date > NOW() - INTERVAL '111 days' THEN 'premium'
            ELSE 'available'
          END as status
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id
        WHERE LOWER(en.name) IN (${placeholders})
        GROUP BY en.id
      `;

      const result = await pool.query(query, exportNames.map(n => n.toLowerCase()));

      // Create a map for ordering
      const dataMap = new Map<string, any>();
      for (const row of result.rows) {
        dataMap.set(row.name.toLowerCase(), row);
      }

      // Generate CSV
      const csvStringifier = stringify({
        header: true,
        columns: CSV_HEADERS,
      });

      const csvChunks: string[] = [];
      csvStringifier.on('data', (chunk: Buffer) => {
        csvChunks.push(chunk.toString());
      });

      // Write data rows in order
      for (const name of exportNames) {
        const row = dataMap.get(name.toLowerCase());
        if (row) {
          csvStringifier.write([
            row.id,
            row.name,
            row.token_id,
            row.owner_address,
            row.expiry_date ? row.expiry_date.toISOString() : '',
            row.status,
            row.list_price || '',
            row.registration_date ? row.registration_date.toISOString() : '',
            Array.isArray(row.clubs) ? row.clubs.join(',') : '',
            row.view_count,
          ]);
        }
      }

      await new Promise<void>((resolve, reject) => {
        csvStringifier.on('finish', resolve);
        csvStringifier.on('error', reject);
        csvStringifier.end();
      });

      const csvContent = csvChunks.join('');

      fastify.log.info(`Watchlist export complete: ${result.rows.length} rows, ${csvContent.length} bytes`);

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return reply.send(csvContent);
    } catch (error: any) {
      fastify.log.error('Error exporting watchlist:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'EXPORT_ERROR',
          message: 'Failed to export watchlist',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
