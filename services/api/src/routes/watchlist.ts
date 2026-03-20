import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse, getElasticsearchClient } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { buildSearchResults } from '../utils/response-builder';
import { buildESQuery } from '../utils/elasticsearch-filters';
import { fetchExportData, exportRowsToCSV, CSV_HEADERS, MAX_EXPORT_ROWS } from '../utils/csv-export';

const AddToWatchlistSchema = z.object({
  ensName: z.string().min(1),
  listId: z.number().int().positive().optional(),
  notifyOnSale: z.boolean().default(true),
  notifyOnOffer: z.boolean().default(true),
  notifyOnListing: z.boolean().default(true),
  notifyOnPriceChange: z.boolean().default(false),
  minOfferThreshold: z.number().min(0).nullable().default(null),
});

const UpdateWatchlistSchema = z.object({
  notifyOnSale: z.boolean().optional(),
  notifyOnOffer: z.boolean().optional(),
  notifyOnListing: z.boolean().optional(),
  notifyOnPriceChange: z.boolean().optional(),
  minOfferThreshold: z.number().min(0).nullable().optional(),
});

const WatchlistQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  listId: z.coerce.number().int().positive().optional(),
});

// Helper to properly parse boolean strings (unlike z.coerce.boolean which treats "false" as true)
const booleanString = z.union([z.boolean(), z.string()]).optional();

const SearchWatchlistQuerySchema = z.object({
  q: z.string().default('*'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['price', 'expiry_date', 'registration_date', 'creation_date', 'last_sale_date',
    'last_sale_price', 'character_count', 'watchers_count', 'clubs_count', 'view_count', 'alphabetical', 'offer',
    'listing_date', 'listing_expiry']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  filters: z.object({
    // Price filters
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),

    // Length filters
    minLength: z.coerce.number().optional(),
    maxLength: z.coerce.number().optional(),

    // Count filters (require PostgreSQL - not in ES index)
    minWatchersCount: z.coerce.number().optional(),
    maxWatchersCount: z.coerce.number().optional(),
    minViewCount: z.coerce.number().optional(),
    maxViewCount: z.coerce.number().optional(),
    minClubsCount: z.coerce.number().optional(),
    maxClubsCount: z.coerce.number().optional(),

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

const MAX_LISTS_PER_USER = 20;

const CreateListSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});

const UpdateListSchema = z.object({
  name: z.string().min(1).max(100).trim(),
});

const BulkAddSchema = z.object({
  listId: z.number().int().positive().optional(),
  ensNames: z.array(z.string().min(1)).min(1).max(100),
});

const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

async function getOrCreateDefaultList(pool: any, userId: number): Promise<number> {
  // Try to find existing default list
  const result = await pool.query(
    'SELECT id FROM watchlist_lists WHERE user_id = $1 AND is_default = TRUE',
    [userId]
  );
  if (result.rows.length > 0) {
    return result.rows[0].id;
  }
  // Create default list
  const insertResult = await pool.query(
    `INSERT INTO watchlist_lists (user_id, name, is_default)
     VALUES ($1, 'Watchlist', TRUE)
     ON CONFLICT (user_id, name) DO UPDATE SET is_default = TRUE
     RETURNING id`,
    [userId]
  );
  return insertResult.rows[0].id;
}

export async function watchlistRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // ─── List CRUD Endpoints ───

  /**
   * GET /api/v1/watchlist/lists
   * Get all user's watchlists with item counts
   */
  fastify.get('/lists', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }, meta: { timestamp: new Date().toISOString() } });
      }
      const userId = parseInt(request.user.sub);

      const result = await pool.query(
        `SELECT wl.id, wl.name, wl.is_default, wl.created_at, wl.updated_at,
           COUNT(w.id)::int as item_count
         FROM watchlist_lists wl
         LEFT JOIN watchlist w ON w.list_id = wl.id
         WHERE wl.user_id = $1
         GROUP BY wl.id
         ORDER BY wl.is_default DESC, wl.created_at ASC`,
        [userId]
      );

      return reply.send({
        success: true,
        data: {
          lists: result.rows.map(row => ({
            id: row.id,
            name: row.name,
            isDefault: row.is_default,
            itemCount: row.item_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          })),
        },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      });
    } catch (error: any) {
      fastify.log.error('Error fetching watchlist lists:', error);
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch lists' }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  /**
   * POST /api/v1/watchlist/lists
   * Create a new named watchlist
   */
  fastify.post('/lists', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }, meta: { timestamp: new Date().toISOString() } });
      }
      const userId = parseInt(request.user.sub);
      const data = CreateListSchema.parse(request.body);

      // Check list limit
      const countResult = await pool.query(
        'SELECT COUNT(*)::int as count FROM watchlist_lists WHERE user_id = $1',
        [userId]
      );
      if (countResult.rows[0].count >= MAX_LISTS_PER_USER) {
        return reply.status(400).send({
          success: false,
          error: { code: 'LIST_LIMIT_REACHED', message: `You can have at most ${MAX_LISTS_PER_USER} lists` },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const result = await pool.query(
        `INSERT INTO watchlist_lists (user_id, name, is_default)
         VALUES ($1, $2, FALSE)
         RETURNING *`,
        [userId, data.name]
      );

      const list = result.rows[0];
      return reply.status(201).send({
        success: true,
        data: {
          id: list.id,
          name: list.name,
          isDefault: list.is_default,
          itemCount: 0,
          createdAt: list.created_at,
          updatedAt: list.updated_at,
        },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      });
    } catch (error: any) {
      fastify.log.error('Error creating watchlist list:', error);
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors }, meta: { timestamp: new Date().toISOString() } });
      }
      if (error?.code === '23505') {
        return reply.status(409).send({ success: false, error: { code: 'DUPLICATE_LIST_NAME', message: 'A list with this name already exists' }, meta: { timestamp: new Date().toISOString() } });
      }
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create list' }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  /**
   * PATCH /api/v1/watchlist/lists/:listId
   * Rename a watchlist
   */
  fastify.patch('/lists/:listId', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }, meta: { timestamp: new Date().toISOString() } });
      }
      const { listId } = request.params as { listId: string };
      const userId = parseInt(request.user.sub);
      const data = UpdateListSchema.parse(request.body);

      // Verify ownership and check if default
      const checkResult = await pool.query(
        'SELECT user_id, is_default FROM watchlist_lists WHERE id = $1',
        [parseInt(listId)]
      );
      if (checkResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'List not found' }, meta: { timestamp: new Date().toISOString() } });
      }
      if (checkResult.rows[0].user_id !== userId) {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'This list belongs to another user' }, meta: { timestamp: new Date().toISOString() } });
      }
      if (checkResult.rows[0].is_default) {
        return reply.status(400).send({ success: false, error: { code: 'CANNOT_RENAME_DEFAULT', message: 'The default watchlist cannot be renamed' }, meta: { timestamp: new Date().toISOString() } });
      }

      const result = await pool.query(
        'UPDATE watchlist_lists SET name = $1 WHERE id = $2 RETURNING *',
        [data.name, parseInt(listId)]
      );

      const list = result.rows[0];
      return reply.send({
        success: true,
        data: {
          id: list.id,
          name: list.name,
          isDefault: list.is_default,
          updatedAt: list.updated_at,
        },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      });
    } catch (error: any) {
      fastify.log.error('Error renaming watchlist list:', error);
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors }, meta: { timestamp: new Date().toISOString() } });
      }
      if (error?.code === '23505') {
        return reply.status(409).send({ success: false, error: { code: 'DUPLICATE_LIST_NAME', message: 'A list with this name already exists' }, meta: { timestamp: new Date().toISOString() } });
      }
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to rename list' }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  /**
   * DELETE /api/v1/watchlist/lists/:listId
   * Delete a watchlist (cascade deletes all entries)
   */
  fastify.delete('/lists/:listId', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }, meta: { timestamp: new Date().toISOString() } });
      }
      const { listId } = request.params as { listId: string };
      const userId = parseInt(request.user.sub);

      const checkResult = await pool.query(
        'SELECT user_id, is_default FROM watchlist_lists WHERE id = $1',
        [parseInt(listId)]
      );
      if (checkResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'List not found' }, meta: { timestamp: new Date().toISOString() } });
      }
      if (checkResult.rows[0].user_id !== userId) {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'This list belongs to another user' }, meta: { timestamp: new Date().toISOString() } });
      }
      if (checkResult.rows[0].is_default) {
        return reply.status(400).send({ success: false, error: { code: 'CANNOT_DELETE_DEFAULT', message: 'The default watchlist cannot be deleted' }, meta: { timestamp: new Date().toISOString() } });
      }

      await pool.query('DELETE FROM watchlist_lists WHERE id = $1', [parseInt(listId)]);

      return reply.send({
        success: true,
        data: { message: 'List deleted' },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      });
    } catch (error: any) {
      fastify.log.error('Error deleting watchlist list:', error);
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete list' }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  // ─── Bulk Operations ───

  /**
   * POST /api/v1/watchlist/bulk
   * Add multiple ENS names to a watchlist at once
   */
  fastify.post('/bulk', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }, meta: { timestamp: new Date().toISOString() } });
      }
      const userId = parseInt(request.user.sub);
      const data = BulkAddSchema.parse(request.body);

      // Resolve list
      let listId: number;
      if (data.listId) {
        const listCheck = await pool.query(
          'SELECT id FROM watchlist_lists WHERE id = $1 AND user_id = $2',
          [data.listId, userId]
        );
        if (listCheck.rows.length === 0) {
          return reply.status(404).send({ success: false, error: { code: 'LIST_NOT_FOUND', message: 'List not found' }, meta: { timestamp: new Date().toISOString() } });
        }
        listId = data.listId;
      } else {
        listId = await getOrCreateDefaultList(pool, userId);
      }

      // Resolve ENS names to IDs
      const ensResult = await pool.query(
        'SELECT id, name FROM ens_names WHERE LOWER(name) = ANY($1::text[])',
        [data.ensNames.map(n => n.toLowerCase())]
      );

      if (ensResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: { code: 'ENS_NAMES_NOT_FOUND', message: 'None of the specified ENS names were found' }, meta: { timestamp: new Date().toISOString() } });
      }

      // Batch insert with ON CONFLICT DO NOTHING
      const values: string[] = [];
      const params: any[] = [listId, userId];
      let paramCount = 3;

      for (const row of ensResult.rows) {
        values.push(`($1, $2, $${paramCount})`);
        params.push(row.id);
        paramCount++;
      }

      const insertResult = await pool.query(
        `INSERT INTO watchlist (list_id, user_id, ens_name_id)
         VALUES ${values.join(', ')}
         ON CONFLICT (list_id, ens_name_id) DO NOTHING
         RETURNING id`,
        params
      );

      return reply.send({
        success: true,
        data: {
          added: insertResult.rowCount,
          alreadyExisted: ensResult.rows.length - (insertResult.rowCount || 0),
          notFound: data.ensNames.length - ensResult.rows.length,
        },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      });
    } catch (error: any) {
      fastify.log.error('Error bulk adding to watchlist:', error);
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors }, meta: { timestamp: new Date().toISOString() } });
      }
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to bulk add to watchlist' }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  /**
   * DELETE /api/v1/watchlist/bulk
   * Remove multiple watchlist entries at once
   */
  fastify.delete('/bulk', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' }, meta: { timestamp: new Date().toISOString() } });
      }
      const userId = parseInt(request.user.sub);
      const data = BulkDeleteSchema.parse(request.body);

      // Delete entries that belong to the user (verified via list ownership)
      const result = await pool.query(
        `DELETE FROM watchlist w
         USING watchlist_lists wl
         WHERE w.list_id = wl.id
           AND wl.user_id = $1
           AND w.id = ANY($2::int[])
         RETURNING w.id`,
        [userId, data.ids]
      );

      return reply.send({
        success: true,
        data: {
          removed: result.rowCount || 0,
        },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      });
    } catch (error: any) {
      fastify.log.error('Error bulk removing from watchlist:', error);
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors }, meta: { timestamp: new Date().toISOString() } });
      }
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to bulk remove from watchlist' }, meta: { timestamp: new Date().toISOString() } });
    }
  });

  // ─── Existing Watchlist Item Endpoints ───

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

      const { page, limit, listId } = WatchlistQuerySchema.parse(request.query);
      const userId = parseInt(request.user.sub);
      const offset = (page - 1) * limit;

      // If listId provided, verify ownership; otherwise default to user's default list
      let resolvedListId: number;
      if (listId) {
        const listCheck = await pool.query(
          'SELECT id FROM watchlist_lists WHERE id = $1 AND user_id = $2',
          [listId, userId]
        );
        if (listCheck.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: 'LIST_NOT_FOUND', message: 'List not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        resolvedListId = listId;
      } else {
        resolvedListId = await getOrCreateDefaultList(pool, userId);
      }

      // Always filter by list_id
      const whereClause = 'w.list_id = $1';
      const whereParam = resolvedListId;

      // Get total count
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM watchlist w WHERE ${whereClause}`,
        [whereParam]
      );

      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / limit);

      // Get watchlist with ENS name details and list info
      const watchlistResult = await pool.query(
        `SELECT
          w.*,
          en.name,
          en.token_id,
          en.owner_address,
          en.expiry_date,
          wl.id as list_id,
          wl.name as list_name,
          wl.is_default as list_is_default,
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
        JOIN watchlist_lists wl ON w.list_id = wl.id
        WHERE ${whereClause}
        ORDER BY w.added_at DESC
        LIMIT $2 OFFSET $3`,
        [whereParam, limit, offset]
      );

      const response: APIResponse = {
        success: true,
        data: {
          watchlist: watchlistResult.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            ensNameId: row.ens_name_id,
            ensName: row.name,
            listId: row.list_id,
            listName: row.list_name,
            notifyOnSale: row.notify_on_sale,
            notifyOnOffer: row.notify_on_offer,
            notifyOnListing: row.notify_on_listing,
            notifyOnPriceChange: row.notify_on_price_change,
            minOfferThreshold: row.min_offer_threshold != null ? parseFloat(row.min_offer_threshold) : null,
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

      // Resolve list
      let listId: number;
      if (data.listId) {
        const listCheck = await pool.query(
          'SELECT id FROM watchlist_lists WHERE id = $1 AND user_id = $2',
          [data.listId, userId]
        );
        if (listCheck.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: 'LIST_NOT_FOUND', message: 'List not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        listId = data.listId;
      } else {
        listId = await getOrCreateDefaultList(pool, userId);
      }

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

      // Insert or update existing watchlist entry within the same list
      const watchlistResult = await pool.query(
        `INSERT INTO watchlist (
          list_id, user_id, ens_name_id, notify_on_sale, notify_on_offer,
          notify_on_listing, notify_on_price_change, min_offer_threshold
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (list_id, ens_name_id)
        DO UPDATE SET
          notify_on_sale = EXCLUDED.notify_on_sale,
          notify_on_offer = EXCLUDED.notify_on_offer,
          notify_on_listing = EXCLUDED.notify_on_listing,
          notify_on_price_change = EXCLUDED.notify_on_price_change,
          min_offer_threshold = EXCLUDED.min_offer_threshold
        RETURNING *`,
        [
          listId,
          userId,
          ensNameId,
          data.notifyOnSale,
          data.notifyOnOffer,
          data.notifyOnListing,
          data.notifyOnPriceChange,
          data.minOfferThreshold,
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
          listId: watchlist.list_id,
          notifyOnSale: watchlist.notify_on_sale,
          notifyOnOffer: watchlist.notify_on_offer,
          notifyOnListing: watchlist.notify_on_listing,
          notifyOnPriceChange: watchlist.notify_on_price_change,
          minOfferThreshold: watchlist.min_offer_threshold != null ? parseFloat(watchlist.min_offer_threshold) : null,
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

      if (updates.minOfferThreshold !== undefined) {
        updateFields.push(`min_offer_threshold = $${paramCount}`);
        values.push(updates.minOfferThreshold);
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
          minOfferThreshold: watchlist.min_offer_threshold != null ? parseFloat(watchlist.min_offer_threshold) : null,
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

      // Look up the ENS name
      const ensResult = await pool.query(
        'SELECT id, name FROM ens_names WHERE LOWER(name) = LOWER($1)',
        [name]
      );

      if (ensResult.rows.length === 0) {
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

      const ensNameId = ensResult.rows[0].id;
      const ensName = ensResult.rows[0].name;

      // Find all list entries for this name
      const result = await pool.query(
        `SELECT
          w.id,
          w.notify_on_sale,
          w.notify_on_offer,
          w.notify_on_listing,
          w.notify_on_price_change,
          w.min_offer_threshold,
          w.added_at,
          wl.id as list_id,
          wl.name as list_name,
          wl.is_default as list_is_default
        FROM watchlist w
        JOIN watchlist_lists wl ON w.list_id = wl.id
        WHERE w.ens_name_id = $1 AND wl.user_id = $2
        ORDER BY wl.is_default DESC, w.added_at ASC`,
        [ensNameId, userId]
      );

      const isWatching = result.rows.length > 0;
      const firstEntry = result.rows[0] || null;

      const response: APIResponse = {
        success: true,
        data: {
          isWatching,
          // Backward-compatible single entry (from default list or first entry)
          watchlistEntry: firstEntry ? {
            id: firstEntry.id,
            ensNameId,
            ensName,
            notifyOnSale: firstEntry.notify_on_sale,
            notifyOnOffer: firstEntry.notify_on_offer,
            notifyOnListing: firstEntry.notify_on_listing,
            notifyOnPriceChange: firstEntry.notify_on_price_change,
            minOfferThreshold: firstEntry.min_offer_threshold != null ? parseFloat(firstEntry.min_offer_threshold) : null,
            addedAt: firstEntry.added_at,
          } : null,
          // Per-list entries
          lists: result.rows.map(row => ({
            listId: row.list_id,
            listName: row.list_name,
            listIsDefault: row.list_is_default,
            watchlistEntryId: row.id,
            notifyOnSale: row.notify_on_sale,
            notifyOnOffer: row.notify_on_offer,
            notifyOnListing: row.notify_on_listing,
            notifyOnPriceChange: row.notify_on_price_change,
            minOfferThreshold: row.min_offer_threshold != null ? parseFloat(row.min_offer_threshold) : null,
            addedAt: row.added_at,
          })),
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
        limit: Math.min(requestedLimit, 100),
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

      // Override limit and page for export mode after Zod validation
      if (isExport) {
        query.limit = Math.min(requestedLimit || MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
        query.page = 1;
      }

      // Support listId query param for filtering by specific list; default to user's default list
      const searchListId = rawQuery.listId ? parseInt(rawQuery.listId, 10) : undefined;
      let resolvedSearchListId: number;

      if (searchListId) {
        const listCheck = await pool.query(
          'SELECT id FROM watchlist_lists WHERE id = $1 AND user_id = $2',
          [searchListId, userId]
        );
        if (listCheck.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: 'LIST_NOT_FOUND', message: 'List not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }
        resolvedSearchListId = searchListId;
      } else {
        resolvedSearchListId = await getOrCreateDefaultList(pool, userId);
      }

      // Get watchlist ENS names for the resolved list
      const watchlistResult = await pool.query(
        `SELECT en.name
         FROM watchlist w
         JOIN ens_names en ON w.ens_name_id = en.id
         WHERE w.list_id = $1`,
        [resolvedSearchListId]
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

      // Check if we need PostgreSQL fallback for sort fields or filters not in Elasticsearch
      const filters = query.filters || {};
      const usePostgresql = query.sortBy === 'watchers_count' || query.sortBy === 'view_count' || query.sortBy === 'clubs_count' ||
        filters.minWatchersCount !== undefined || filters.maxWatchersCount !== undefined ||
        filters.minViewCount !== undefined || filters.maxViewCount !== undefined ||
        filters.minClubsCount !== undefined || filters.maxClubsCount !== undefined;

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

        // Watchers count filters
        if (filters.minWatchersCount !== undefined) {
          whereConditions.push(`(SELECT COUNT(DISTINCT user_id) FROM watchlist WHERE ens_name_id = en.id) >= $${paramCount}`);
          params.push(filters.minWatchersCount);
          paramCount++;
        }
        if (filters.maxWatchersCount !== undefined) {
          whereConditions.push(`(SELECT COUNT(DISTINCT user_id) FROM watchlist WHERE ens_name_id = en.id) <= $${paramCount}`);
          params.push(filters.maxWatchersCount);
          paramCount++;
        }

        // View count filters
        if (filters.minViewCount !== undefined) {
          whereConditions.push(`COALESCE(en.view_count, 0) >= $${paramCount}`);
          params.push(filters.minViewCount);
          paramCount++;
        }
        if (filters.maxViewCount !== undefined) {
          whereConditions.push(`COALESCE(en.view_count, 0) <= $${paramCount}`);
          params.push(filters.maxViewCount);
          paramCount++;
        }

        // Clubs count filters
        if (filters.minClubsCount !== undefined) {
          whereConditions.push(`COALESCE(array_length(en.clubs, 1), 0) >= $${paramCount}`);
          params.push(filters.minClubsCount);
          paramCount++;
        }
        if (filters.maxClubsCount !== undefined) {
          whereConditions.push(`COALESCE(array_length(en.clubs, 1), 0) <= $${paramCount}`);
          params.push(filters.maxClubsCount);
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
          selectClause = 'en.name, (SELECT COUNT(DISTINCT user_id) FROM watchlist WHERE ens_name_id = en.id) as sort_value';
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

      // Fetch watchlist preferences for each result (including list info)
      const watchlistPrefsResult = await pool.query(
        `SELECT
          w.ens_name_id,
          w.notify_on_sale,
          w.notify_on_offer,
          w.notify_on_listing,
          w.notify_on_price_change,
          w.min_offer_threshold,
          w.id as watchlist_id,
          w.added_at,
          w.list_id,
          wl.name as list_name,
          en.name
        FROM watchlist w
        JOIN ens_names en ON w.ens_name_id = en.id
        JOIN watchlist_lists wl ON w.list_id = wl.id
        WHERE w.user_id = $1 AND en.name = ANY($2)`,
        [userId, resultNames]
      );

      // Create a map of name -> watchlist data (array of entries across lists)
      const watchlistMap = new Map<string, any[]>();
      watchlistPrefsResult.rows.forEach(row => {
        const entry = {
          watchlistId: row.watchlist_id,
          listId: row.list_id,
          listName: row.list_name,
          notifyOnSale: row.notify_on_sale,
          notifyOnOffer: row.notify_on_offer,
          notifyOnListing: row.notify_on_listing,
          notifyOnPriceChange: row.notify_on_price_change,
          minOfferThreshold: row.min_offer_threshold != null ? parseFloat(row.min_offer_threshold) : null,
          addedAt: row.added_at,
        };
        const existing = watchlistMap.get(row.name);
        if (existing) {
          existing.push(entry);
        } else {
          watchlistMap.set(row.name, [entry]);
        }
      });

      // Merge watchlist data with search results
      const enrichedResults = results.map(result => {
        const entries = watchlistMap.get(result.name);
        return {
          ...result,
          // Backward-compatible: first entry (or null)
          watchlist: entries?.[0] || null,
          // All list entries
          watchlistEntries: entries || [],
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
