import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPostgresPool, type APIResponse, CURRENCY_ADDRESSES } from '../../../shared/src';
import { cacheHandler } from '../middleware/cache';
import { optionalAuth } from '../middleware/auth';
import { mutelistService } from '../services/mutelist';

const pool = getPostgresPool();

interface ActivityQueryParams {
  name?: string;
  page?: string;
  limit?: string;
  event_type?: string | string[];
  platform?: string | string[];
  actor_address?: string;
  club?: string;
  watchlist?: string;
  list_id?: string;
  min_price_wei?: string;
  max_price_wei?: string;
}

export async function activityRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/activity/:name
   * Get activity history for a specific ENS name
   */
  fastify.get('/:name', { preHandler: cacheHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { name } = request.params as { name: string };
    const {
      page = '1',
      limit = '50',
      event_type,
      platform,
    } = request.query as ActivityQueryParams;

    try {
      // First, get the ens_name_id
      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE name = $1',
        [name]
      );

      if (ensResult.rows.length === 0) {
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

      const ensNameId = ensResult.rows[0].id;

      // Parse pagination params
      const currentPage = parseInt(page);
      const pageLimit = parseInt(limit);
      const offset = (currentPage - 1) * pageLimit;

      // Build the WHERE clause dynamically
      const conditions = ['ens_name_id = $1'];
      const params: any[] = [ensNameId];
      let paramCount = 1;

      if (event_type) {
        const eventTypes = Array.isArray(event_type) ? event_type : [event_type];
        const placeholders = eventTypes.map((_, i) => `$${paramCount + i + 1}`).join(', ');
        paramCount += eventTypes.length;
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...eventTypes);
      }

      if (platform) {
        // Accept ?platform=opensea&platform=grails OR ?platform=opensea,grails
        const platforms = (Array.isArray(platform) ? platform : platform.split(','))
          .map(p => p.trim())
          .filter(Boolean);
        if (platforms.length > 0) {
          const placeholders = platforms.map((_, i) => `$${paramCount + i + 1}`).join(', ');
          paramCount += platforms.length;
          conditions.push(`platform IN (${placeholders})`);
          params.push(...platforms);
        }
      }

      const whereClause = conditions.join(' AND ');

      // Add limit and offset
      paramCount++;
      const limitParam = `$${paramCount}`;
      paramCount++;
      const offsetParam = `$${paramCount}`;
      params.push(pageLimit, offset);

      // Get activity history with ENS name details
      const query = `
        SELECT
          ah.id,
          ah.ens_name_id,
          ah.event_type,
          ah.actor_address,
          ah.counterparty_address,
          ah.platform,
          ah.chain_id,
          ah.price_wei,
          ah.currency_address,
          ah.transaction_hash,
          ah.block_number,
          ah.metadata,
          timezone('UTC', ah.created_at) as created_at,
          en.name,
          en.token_id,
          en.clubs
        FROM activity_history ah
        JOIN ens_names en ON ah.ens_name_id = en.id
        WHERE ${whereClause}
        ORDER BY ah.created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `;

      const result = await pool.query(query, params);

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM activity_history
        WHERE ${whereClause}
      `;
      const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit/offset params

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / pageLimit);

      const response: APIResponse = {
        success: true,
        data: {
          results: result.rows,
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
      fastify.log.error('Error fetching activity history:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Failed to fetch activity history',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/activity/address/:address
   * Get activity history for a specific address (buyer or seller)
   */
  fastify.get('/address/:address', { preHandler: cacheHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { address } = request.params as { address: string };
    const {
      page = '1',
      limit = '50',
      event_type,
      platform,
    } = request.query as ActivityQueryParams;

    try {
      // Parse pagination params
      const currentPage = parseInt(page);
      const pageLimit = parseInt(limit);
      const offset = (currentPage - 1) * pageLimit;

      // Build the WHERE clause dynamically
      const conditions = ['(actor_address = $1 OR counterparty_address = $1)'];
      const params: any[] = [address.toLowerCase()];
      let paramCount = 1;

      if (event_type) {
        const eventTypes = Array.isArray(event_type) ? event_type : [event_type];
        const placeholders = eventTypes.map((_, i) => `$${paramCount + i + 1}`).join(', ');
        paramCount += eventTypes.length;
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...eventTypes);
      }

      if (platform) {
        // Accept ?platform=opensea&platform=grails OR ?platform=opensea,grails
        const platforms = (Array.isArray(platform) ? platform : platform.split(','))
          .map(p => p.trim())
          .filter(Boolean);
        if (platforms.length > 0) {
          const placeholders = platforms.map((_, i) => `$${paramCount + i + 1}`).join(', ');
          paramCount += platforms.length;
          conditions.push(`platform IN (${placeholders})`);
          params.push(...platforms);
        }
      }

      const whereClause = conditions.join(' AND ');

      // Add limit and offset
      paramCount++;
      const limitParam = `$${paramCount}`;
      paramCount++;
      const offsetParam = `$${paramCount}`;
      params.push(pageLimit, offset);

      // Get activity history with ENS name details
      const query = `
        SELECT
          ah.id,
          ah.ens_name_id,
          ah.event_type,
          ah.actor_address,
          ah.counterparty_address,
          ah.platform,
          ah.chain_id,
          ah.price_wei,
          ah.currency_address,
          ah.transaction_hash,
          ah.block_number,
          ah.metadata,
          timezone('UTC', ah.created_at) as created_at,
          en.name,
          en.token_id,
          en.clubs
        FROM activity_history ah
        JOIN ens_names en ON ah.ens_name_id = en.id
        WHERE ${whereClause}
        ORDER BY ah.created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `;

      const result = await pool.query(query, params);

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM activity_history ah
        WHERE ${whereClause}
      `;
      const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit/offset params

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / pageLimit);

      const response: APIResponse = {
        success: true,
        data: {
          results: result.rows,
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
      fastify.log.error('Error fetching activity history for address:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Failed to fetch activity history',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/activity
   * Get recent activity across all ENS names (global feed)
   */
  fastify.get('/', { preHandler: [optionalAuth, cacheHandler] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const {
      page = '1',
      limit = '50',
      event_type,
      platform,
      club,
      watchlist,
      list_id,
      min_price_wei,
      max_price_wei,
    } = request.query as ActivityQueryParams;

    try {
      // The watchlist filter needs an authenticated user to resolve their list.
      const userId = request.user ? parseInt(request.user.sub, 10) : null;
      if (watchlist === 'true' && userId == null) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required to filter activity by watchlist',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // Validate price thresholds up front (decimal wei strings only)
      if (min_price_wei !== undefined && !/^\d+$/.test(min_price_wei)) {
        return reply.status(400).send({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'min_price_wei must be a decimal wei string' },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      if (max_price_wei !== undefined && !/^\d+$/.test(max_price_wei)) {
        return reply.status(400).send({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'max_price_wei must be a decimal wei string' },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // Parse pagination params
      const currentPage = parseInt(page);
      const pageLimit = parseInt(limit);
      const offset = (currentPage - 1) * pageLimit;

      // Build the WHERE clause dynamically
      const conditions: string[] = [];
      const params: any[] = [];
      let paramCount = 0;

      if (event_type) {
        const eventTypes = Array.isArray(event_type) ? event_type : [event_type];
        const placeholders = eventTypes.map((_, i) => `$${paramCount + i + 1}`).join(', ');
        paramCount += eventTypes.length;
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...eventTypes);
      }

      if (platform) {
        // Accept ?platform=opensea&platform=grails OR ?platform=opensea,grails
        const platforms = (Array.isArray(platform) ? platform : platform.split(','))
          .map(p => p.trim())
          .filter(Boolean);
        if (platforms.length > 0) {
          const placeholders = platforms.map((_, i) => `$${paramCount + i + 1}`).join(', ');
          paramCount += platforms.length;
          conditions.push(`platform IN (${placeholders})`);
          params.push(...platforms);
        }
      }

      if (club) {
        if (club.toLowerCase() === 'any') {
          // Return activity for any name that's in at least one club
          conditions.push(`en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0`);
        } else {
          // Return activity for names in a specific club
          paramCount++;
          conditions.push(`$${paramCount} = ANY(en.clubs)`);
          params.push(club);
        }
      }

      // Add mutelist filtering - exclude activity where actor or counterparty is muted
      // Get muted addresses once and filter in the query
      const mutedAddresses = mutelistService.getMutedAddresses();
      if (mutedAddresses.length > 0) {
        paramCount++;
        conditions.push(`ah.actor_address != ALL($${paramCount})`);
        params.push(mutedAddresses);
        paramCount++;
        conditions.push(`(ah.counterparty_address IS NULL OR ah.counterparty_address != ALL($${paramCount}))`);
        params.push(mutedAddresses);
      }

      // Watchlist filter - restrict to names on the authenticated user's watchlist.
      // Optional list_id scopes to a single list; omitted = union of all the user's lists.
      if (watchlist === 'true' && userId != null) {
        paramCount++;
        const userParam = `$${paramCount}`;
        params.push(userId);
        const listId = list_id ? parseInt(list_id, 10) : null;
        if (listId != null && !Number.isNaN(listId)) {
          paramCount++;
          conditions.push(
            `ah.ens_name_id IN (SELECT ens_name_id FROM watchlist WHERE user_id = ${userParam} AND list_id = $${paramCount})`
          );
          params.push(listId);
        } else {
          conditions.push(
            `ah.ens_name_id IN (SELECT ens_name_id FROM watchlist WHERE user_id = ${userParam})`
          );
        }
      }

      // Price threshold filter - applies only to ETH/WETH-denominated priced events.
      // Events with no price (price_wei IS NULL: pure transfers, etc.) always pass through.
      // currency_address IS NULL means a blockchain mint/renewal cost, which is ETH-denominated.
      const priceConds: string[] = [];
      if (min_price_wei !== undefined) {
        paramCount++;
        priceConds.push(`CAST(ah.price_wei AS NUMERIC) >= $${paramCount}`);
        params.push(min_price_wei);
      }
      if (max_price_wei !== undefined) {
        paramCount++;
        priceConds.push(`CAST(ah.price_wei AS NUMERIC) <= $${paramCount}`);
        params.push(max_price_wei);
      }
      if (priceConds.length > 0) {
        paramCount++;
        const ethParam = `$${paramCount}`;
        params.push(CURRENCY_ADDRESSES.ETH.toLowerCase());
        paramCount++;
        const wethParam = `$${paramCount}`;
        params.push(CURRENCY_ADDRESSES.WETH.toLowerCase());
        conditions.push(
          `(ah.price_wei IS NULL OR ((ah.currency_address IS NULL OR LOWER(ah.currency_address) IN (${ethParam}, ${wethParam})) AND ${priceConds.join(' AND ')}))`
        );
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Add limit and offset
      paramCount++;
      const limitParam = `$${paramCount}`;
      paramCount++;
      const offsetParam = `$${paramCount}`;
      params.push(pageLimit, offset);

      // Get activity history with ENS name details
      const query = `
        SELECT
          ah.id,
          ah.ens_name_id,
          ah.event_type,
          ah.actor_address,
          ah.counterparty_address,
          ah.platform,
          ah.chain_id,
          ah.price_wei,
          ah.currency_address,
          ah.transaction_hash,
          ah.block_number,
          ah.metadata,
          timezone('UTC', ah.created_at) as created_at,
          en.name,
          en.token_id,
          en.clubs
        FROM activity_history ah
        JOIN ens_names en ON ah.ens_name_id = en.id
        ${whereClause}
        ORDER BY ah.created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `;

      const countQuery = `
        SELECT COUNT(*) as total
        FROM activity_history ah
        JOIN ens_names en ON ah.ens_name_id = en.id
        ${whereClause}
      `;

      const [result, countResult] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, params.slice(0, -2)),
      ]);

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / pageLimit);

      const response: APIResponse = {
        success: true,
        data: {
          results: result.rows,
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
      fastify.log.error('Error fetching global activity history:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Failed to fetch activity history',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
