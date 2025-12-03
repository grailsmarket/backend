import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { cacheHandler } from '../middleware/cache';
import { mutelistService } from '../services/mutelist';

const pool = getPostgresPool();

interface ActivityQueryParams {
  name?: string;
  page?: string;
  limit?: string;
  event_type?: string | string[];
  platform?: string;
  actor_address?: string;
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
        paramCount++;
        conditions.push(`platform = $${paramCount}`);
        params.push(platform);
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
          en.token_id
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
        paramCount++;
        conditions.push(`platform = $${paramCount}`);
        params.push(platform);
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
          en.token_id
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
  fastify.get('/', { preHandler: cacheHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
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
        paramCount++;
        conditions.push(`platform = $${paramCount}`);
        params.push(platform);
      }

      // Add mutelist filtering - exclude activity where actor or counterparty is muted
      // Use NOT EXISTS with mutelist table for efficient filtering at database level
      conditions.push(`
        NOT EXISTS (
          SELECT 1 FROM mutelist
          WHERE LOWER(address) = LOWER(ah.actor_address)
             OR LOWER(address) = LOWER(ah.counterparty_address)
        )
      `);

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
          en.token_id
        FROM activity_history ah
        JOIN ens_names en ON ah.ens_name_id = en.id
        ${whereClause}
        ORDER BY ah.created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `;

      const result = await pool.query(query, params);

      const countQuery = `
        SELECT COUNT(*) as total
        FROM activity_history ah
        ${whereClause}
      `;
      const countResult = await pool.query(countQuery, params.slice(0, -2));

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
