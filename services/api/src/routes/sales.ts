import { FastifyInstance } from 'fastify';
import {
  getPostgresPool,
  APIResponse,
  getSalesByName,
  getSalesByAddress,
  getRecentSales,
  getSalesAnalytics
} from '../../../shared/src';

export async function salesRoutes(fastify: FastifyInstance) {
  // GET /api/v1/sales - Get recent sales
  fastify.get('/', async (request, reply) => {
    const { page = '1', limit = '20' } = request.query as any;
    const currentPage = parseInt(page);
    const pageLimit = parseInt(limit);
    const offset = (currentPage - 1) * pageLimit;

    try {
      const { results, total } = await getRecentSales(pageLimit, offset);
      const totalPages = Math.ceil(total / pageLimit);

      const response: APIResponse = {
        success: true,
        data: {
          results,
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
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch sales',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  // GET /api/v1/sales/name/:name - Get sales for specific ENS name
  fastify.get('/name/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const { page = '1', limit = '20' } = request.query as any;
    const currentPage = parseInt(page);
    const pageLimit = parseInt(limit);
    const offset = (currentPage - 1) * pageLimit;

    try {
      const { results, total } = await getSalesByName(name, pageLimit, offset);
      const totalPages = Math.ceil(total / pageLimit);

      const response: APIResponse = {
        success: true,
        data: {
          results,
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
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch sales',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  // GET /api/v1/sales/address/:address - Get sales by address
  fastify.get('/address/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = '1', limit = '20', type = 'both' } = request.query as any;
    const currentPage = parseInt(page);
    const pageLimit = parseInt(limit);
    const offset = (currentPage - 1) * pageLimit;

    try {
      const { results, total } = await getSalesByAddress(
        address,
        type,
        pageLimit,
        offset
      );
      const totalPages = Math.ceil(total / pageLimit);

      const response: APIResponse = {
        success: true,
        data: {
          results,
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
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch sales',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  // GET /api/v1/sales/:nameOrId/analytics - Get sales analytics
  fastify.get('/:nameOrId/analytics', async (request, reply) => {
    const { nameOrId } = request.params as { nameOrId: string };

    try {
      // Try to get ens_name_id
      const pool = getPostgresPool();
      let ensNameId: number;

      if (isNaN(parseInt(nameOrId))) {
        // It's a name
        const result = await pool.query(
          'SELECT id FROM ens_names WHERE name = $1',
          [nameOrId]
        );
        if (result.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: 'ENS name not found',
          });
        }
        ensNameId = result.rows[0].id;
      } else {
        ensNameId = parseInt(nameOrId);
      }

      const analytics = await getSalesAnalytics(ensNameId);

      const response: APIResponse = {
        success: true,
        data: analytics,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch analytics',
      });
    }
  });
}
