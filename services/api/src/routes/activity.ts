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

      // The club filter is the only predicate that touches ens_names. We render it two
      // ways: the main query keeps the JOIN (it selects en.* columns anyway), while the
      // COUNT query expresses it as a semi-join subquery on ens_name_id so it can drop
      // the JOIN entirely. The subquery resolves via the GIN index on ens_names.clubs and
      // avoids the full activity_history⋈ens_names hash join + sort that was driving
      // Postgres into parallel plans (and exhausting /dev/shm under concurrent requests).
      let clubJoinCond: string | null = null; // main query: predicate on the joined en.*
      let clubCountCond: string | null = null; // count query: semi-join on ah.ens_name_id
      if (club) {
        if (club.toLowerCase() === 'any') {
          // Return activity for any name that's in at least one club
          clubJoinCond = `en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0`;
          clubCountCond = `ah.ens_name_id IN (SELECT id FROM ens_names WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0)`;
        } else {
          // Return activity for names in a specific club
          paramCount++;
          clubJoinCond = `$${paramCount} = ANY(en.clubs)`;
          clubCountCond = `ah.ens_name_id IN (SELECT id FROM ens_names WHERE $${paramCount} = ANY(clubs))`;
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

      // Price threshold filter - an active bound requires a real, in-range, ETH/WETH-denominated
      // price. Events with no price (price_wei IS NULL: pure transfers, un-enriched mints, etc.)
      // are excluded while filtering by price (a NULL makes the CAST comparison UNKNOWN, so the
      // row drops out). currency_address IS NULL means a blockchain mint/renewal cost (ETH-denominated).
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
          `((ah.currency_address IS NULL OR LOWER(ah.currency_address) IN (${ethParam}, ${wethParam})) AND ${priceConds.join(' AND ')})`
        );
      }

      // Main query joins ens_names and uses the en.* form of the club predicate.
      const mainConditions = clubJoinCond ? [...conditions, clubJoinCond] : conditions;
      const whereClause = mainConditions.length > 0 ? `WHERE ${mainConditions.join(' AND ')}` : '';

      // Count query drops the JOIN: every other condition is already on activity_history
      // (ah.*), and the club predicate becomes a semi-join subquery. Same params/positions.
      const countConditions = clubCountCond ? [...conditions, clubCountCond] : conditions;
      const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';

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
        ${countWhere}
      `;

      // Run both queries on a single connection inside a transaction with parallel query
      // disabled (SET LOCAL auto-reverts on COMMIT, leaving the pooled connection clean).
      // This is a surgical, endpoint-scoped guard against the "could not resize shared
      // memory segment / No space left on device" failures that hit when several of these
      // requests fire concurrently: parallel-query workers allocate DSM in the container's
      // small /dev/shm. Disabling parallelism here removes that allocation without a
      // database-wide setting. Single connection also halves pool usage under bursts.
      const client = await pool.connect();
      let result;
      let countResult;
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
        result = await client.query(query, params);
        countResult = await client.query(countQuery, params.slice(0, -2));
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK').catch(() => {});
        throw txError;
      } finally {
        client.release();
      }

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
      // Log the full error server-side; never leak raw Postgres error text to clients
      // (information disclosure + opaque UX). Return a generic, stable message instead.
      fastify.log.error('Error fetching global activity history:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch activity history',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
