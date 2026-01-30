import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, getElasticsearchClient } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { buildSearchResults } from '../utils/response-builder';
import { buildESQuery } from '../utils/elasticsearch-filters';
import { fetchExportData, exportRowsToCSV, CSV_HEADERS, MAX_EXPORT_ROWS } from '../utils/csv-export';

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
    'last_sale_price', 'character_count', 'watchers_count', 'clubs_count', 'view_count', 'alphabetical', 'offer']).optional(),
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
   * Set export=true to download results as CSV
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
      const rawQuery = request.query as any;
      const isExport = rawQuery.export === 'true' || rawQuery.export === true;
      const filename = rawQuery.filename || 'watchlist-export';

      // Transform flat query params into nested structure (same as /names/search)
      // For export mode, allow higher limit
      const requestedLimit = parseInt(rawQuery.limit || '20', 10);
      const transformedQuery: any = {
        q: rawQuery.q,
        page: isExport ? 1 : parseInt(rawQuery.page || '1', 10),
        limit: isExport ? Math.min(requestedLimit || MAX_EXPORT_ROWS, MAX_EXPORT_ROWS) : Math.min(requestedLimit, 100),
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
        if (isExport) {
          reply.header('Content-Type', 'text/csv');
          reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
          return reply.send(CSV_HEADERS.join(',') + '\n');
        }

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

      // Check if we need PostgreSQL fallback for sort fields not in Elasticsearch
      const usePostgresql = query.sortBy === 'watchers_count' || query.sortBy === 'view_count' || query.sortBy === 'clubs_count';
      const filters = query.filters || {};

      let resultNames: string[] = [];
      let total = 0;

      if (usePostgresql) {
        // PostgreSQL fallback for sort fields not available in Elasticsearch
        const whereConditions: string[] = [];
        const params: any[] = [];
        let paramCount = 1;

        // Restrict to watchlist items
        whereConditions.push(`en.name = ANY($${paramCount}::text[])`);
        params.push(watchlistNames);
        paramCount++;

        // Exclude placeholder names and subnames
        whereConditions.push(`en.name NOT LIKE 'token-%'`);
        whereConditions.push(`en.name NOT LIKE '[%'`);
        whereConditions.push(`en.name NOT LIKE '%.%.eth'`);

        // Apply filters
        if (filters.listed === 'true' || filters.listed === true) {
          whereConditions.push(`l.status = 'active'`);
        } else if (filters.listed === 'false' || filters.listed === false) {
          whereConditions.push(`(l.id IS NULL OR l.status != 'active')`);
        }

        if (filters.hasOffer === 'true' || filters.hasOffer === true) {
          whereConditions.push(`en.highest_offer_wei IS NOT NULL AND CAST(en.highest_offer_wei AS NUMERIC) > 0`);
        } else if (filters.hasOffer === 'false' || filters.hasOffer === false) {
          whereConditions.push(`(en.highest_offer_wei IS NULL OR CAST(en.highest_offer_wei AS NUMERIC) <= 0)`);
        }

        if (filters.minPrice) {
          whereConditions.push(`CAST(l.price_wei AS NUMERIC) >= $${paramCount}`);
          params.push(filters.minPrice);
          paramCount++;
        }
        if (filters.maxPrice) {
          whereConditions.push(`CAST(l.price_wei AS NUMERIC) <= $${paramCount}`);
          params.push(filters.maxPrice);
          paramCount++;
        }

        if (filters.minLength) {
          whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) >= $${paramCount}`);
          params.push(filters.minLength);
          paramCount++;
        }
        if (filters.maxLength) {
          whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) <= $${paramCount}`);
          params.push(filters.maxLength);
          paramCount++;
        }

        // Character filters
        if (filters.digits === 'exclude') {
          whereConditions.push(`en.has_numbers = false`);
        } else if (filters.digits === 'only') {
          whereConditions.push(`REPLACE(en.name, '.eth', '') ~ '^[0-9]+$'`);
        }

        if (filters.letters === 'exclude') {
          whereConditions.push(`REPLACE(en.name, '.eth', '') !~ '[a-zA-Z]'`);
        } else if (filters.letters === 'only') {
          whereConditions.push(`REPLACE(en.name, '.eth', '') ~ '^[a-zA-Z]+$'`);
        }

        if (filters.emoji === 'exclude') {
          whereConditions.push(`en.has_emoji = false`);
        } else if (filters.emoji === 'only') {
          whereConditions.push(`en.has_emoji = true`);
          whereConditions.push(`REPLACE(en.name, '.eth', '') !~ '[a-zA-Z0-9]'`);
        }

        if (filters.repeatingChars === 'exclude') {
          whereConditions.push(`REPLACE(en.name, '.eth', '') !~ '^(.)\\1*$'`);
        } else if (filters.repeatingChars === 'only') {
          whereConditions.push(`REPLACE(en.name, '.eth', '') ~ '^(.)\\1*$'`);
        }

        // Legacy character filters
        if (filters.hasNumbers !== undefined) {
          whereConditions.push(`en.has_numbers = $${paramCount}`);
          params.push(filters.hasNumbers === 'true' || filters.hasNumbers === true);
          paramCount++;
        }
        if (filters.hasEmoji !== undefined) {
          whereConditions.push(`en.has_emoji = $${paramCount}`);
          params.push(filters.hasEmoji === 'true' || filters.hasEmoji === true);
          paramCount++;
        }

        // Club filters
        if (filters.clubs && filters.clubs.length > 0) {
          if (filters.clubs.includes('none')) {
            whereConditions.push(`(en.clubs IS NULL OR array_length(en.clubs, 1) = 0)`);
          } else if (filters.clubs.includes('any')) {
            whereConditions.push(`en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0`);
          } else {
            whereConditions.push(`en.clubs && $${paramCount}::text[]`);
            params.push(filters.clubs);
            paramCount++;
          }
        }

        if (filters.inAnyClub !== undefined) {
          const wantInClub = filters.inAnyClub === 'true' || filters.inAnyClub === true;
          if (wantInClub) {
            whereConditions.push(`en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0`);
          } else {
            whereConditions.push(`(en.clubs IS NULL OR array_length(en.clubs, 1) = 0)`);
          }
        }

        // Status filter
        if (filters.status && filters.status !== 'all') {
          switch (filters.status) {
            case 'registered':
              whereConditions.push(`en.expiry_date > NOW()`);
              break;
            case 'grace':
              whereConditions.push(`(en.expiry_date <= NOW() AND en.expiry_date > NOW() - INTERVAL '90 days')`);
              break;
            case 'premium':
              whereConditions.push(`(en.expiry_date <= NOW() - INTERVAL '90 days' AND en.expiry_date > NOW() - INTERVAL '111 days')`);
              break;
            case 'available':
              whereConditions.push(`en.expiry_date <= NOW() - INTERVAL '111 days'`);
              break;
          }
        }

        // Legacy expiration filters
        if (filters.isExpired !== undefined) {
          const wantExpired = filters.isExpired === 'true' || filters.isExpired === true;
          if (wantExpired) {
            whereConditions.push(`en.expiry_date <= NOW()`);
          } else {
            whereConditions.push(`en.expiry_date > NOW()`);
          }
        }

        if (filters.isGracePeriod !== undefined) {
          const wantGracePeriod = filters.isGracePeriod === 'true' || filters.isGracePeriod === true;
          if (wantGracePeriod) {
            whereConditions.push(`(en.expiry_date <= NOW() AND en.expiry_date > NOW() - INTERVAL '90 days')`);
          }
        }

        if (filters.isPremiumPeriod !== undefined) {
          const wantPremiumPeriod = filters.isPremiumPeriod === 'true' || filters.isPremiumPeriod === true;
          if (wantPremiumPeriod) {
            whereConditions.push(`(en.expiry_date <= NOW() - INTERVAL '90 days' AND en.expiry_date > NOW() - INTERVAL '111 days')`);
          }
        }

        if (filters.expiringWithinDays !== undefined) {
          const days = parseInt(String(filters.expiringWithinDays));
          whereConditions.push(`en.expiry_date > NOW() AND en.expiry_date <= NOW() + INTERVAL '${days} days'`);
        }

        // Sale history filters
        if (filters.hasSales !== undefined) {
          const wantSales = filters.hasSales === 'true' || filters.hasSales === true;
          if (wantSales) {
            whereConditions.push(`en.last_sale_date IS NOT NULL`);
          } else {
            whereConditions.push(`en.last_sale_date IS NULL`);
          }
        }

        if (filters.lastSoldAfter) {
          whereConditions.push(`en.last_sale_date >= $${paramCount}`);
          params.push(filters.lastSoldAfter);
          paramCount++;
        }
        if (filters.lastSoldBefore) {
          whereConditions.push(`en.last_sale_date <= $${paramCount}`);
          params.push(filters.lastSoldBefore);
          paramCount++;
        }

        // String pattern filters
        if (filters.contains) {
          whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
          params.push(`%${filters.contains.toLowerCase()}%`);
          paramCount++;
        }
        if (filters.startsWith) {
          whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
          params.push(`${filters.startsWith.toLowerCase()}%`);
          paramCount++;
        }
        if (filters.endsWith) {
          whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
          params.push(`%${filters.endsWith.toLowerCase()}.eth`);
          paramCount++;
        }
        if (filters.doesNotContain) {
          whereConditions.push(`LOWER(en.name) NOT LIKE $${paramCount}`);
          params.push(`%${filters.doesNotContain.toLowerCase()}%`);
          paramCount++;
        }
        if (filters.doesNotStartWith) {
          whereConditions.push(`LOWER(en.name) NOT LIKE $${paramCount}`);
          params.push(`${filters.doesNotStartWith.toLowerCase()}%`);
          paramCount++;
        }
        if (filters.doesNotEndWith) {
          whereConditions.push(`LOWER(en.name) NOT LIKE $${paramCount}`);
          params.push(`%${filters.doesNotEndWith.toLowerCase()}.eth`);
          paramCount++;
        }

        // Search query filter
        if (query.q && query.q !== '*') {
          whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
          params.push(`%${query.q.toLowerCase()}%`);
          paramCount++;
        }

        const whereClause = whereConditions.join(' AND ');

        // Build ORDER BY clause
        const order = query.sortOrder || 'desc';
        const sqlOrder = order.toUpperCase();
        let orderByClause = '';
        let selectClause = '';

        if (query.sortBy === 'watchers_count') {
          selectClause = 'en.name, (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as sort_value';
          orderByClause = `ORDER BY sort_value ${sqlOrder}`;
        } else if (query.sortBy === 'view_count') {
          selectClause = 'en.name, COALESCE(en.view_count, 0) as sort_value';
          orderByClause = `ORDER BY sort_value ${sqlOrder}`;
        } else if (query.sortBy === 'clubs_count') {
          selectClause = 'en.name, (en.name COLLATE "C") as name_sort, COALESCE(array_length(en.clubs, 1), 0) as sort_value';
          orderByClause = `ORDER BY sort_value ${sqlOrder}, name_sort ASC`;
        }

        const offset = (query.page - 1) * query.limit;

        // Count query
        const countQuery = `
          SELECT COUNT(DISTINCT en.id)
          FROM ens_names en
          LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
          WHERE ${whereClause}
        `;

        // Data query
        const dataQuery = `
          SELECT ${selectClause}
          FROM ens_names en
          LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
          WHERE ${whereClause}
          ${orderByClause}
          LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        params.push(query.limit, offset);

        const [countResult, dataResult] = await Promise.all([
          pool.query(countQuery, params.slice(0, -2)),
          pool.query(dataQuery, params),
        ]);

        total = parseInt(countResult.rows[0].count);
        resultNames = dataResult.rows.map((row: any) => row.name);
      } else {
        // Use Elasticsearch for other sort fields
        const esClient = getElasticsearchClient();
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
        total = typeof esResponse.hits.total === 'number'
          ? esResponse.hits.total
          : esResponse.hits.total?.value ?? 0;

        resultNames = hits.map((hit: any) => hit._source.name);
      }

      // Handle export mode - use fast lightweight query
      if (isExport) {
        const exportRows = await fetchExportData(pool, resultNames);
        const csvContent = await exportRowsToCSV(exportRows);
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return reply.send(csvContent);
      }

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
}
