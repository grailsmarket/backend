import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { searchNames } from '../services/search';
import { buildSearchResults } from '../utils/response-builder';

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

const SearchWatchlistQuerySchema = z.object({
  q: z.string().default('*'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  filters: z.object({
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),
    minLength: z.coerce.number().optional(),
    maxLength: z.coerce.number().optional(),
    hasNumbers: z.coerce.boolean().optional(),
    hasEmoji: z.coerce.boolean().optional(),
    clubs: z.array(z.string()).optional(),
    isExpired: z.coerce.boolean().optional(),
    isGracePeriod: z.coerce.boolean().optional(),
    isPremiumPeriod: z.coerce.boolean().optional(),
    expiringWithinDays: z.coerce.number().optional(),
    hasSales: z.coerce.boolean().optional(),
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

      // Search within watchlist using Elasticsearch
      const esResults = await searchNames({
        q: query.q,
        page: query.page,
        limit: query.limit,
        ensNames: watchlistNames, // Restrict search to watchlist items only
        filters: query.filters,
      });

      // Extract names from Elasticsearch results
      const resultNames = esResults.results.map((hit: any) => hit.name);

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

      const response: APIResponse = {
        success: true,
        data: {
          results: enrichedResults,
          pagination: esResults.pagination,
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
