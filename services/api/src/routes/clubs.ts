import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { searchNames } from '../services/search';
import { veryLongCacheHandler, cacheHandler } from '../middleware/cache';

export async function clubsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // Get all clubs with metadata
  fastify.get('/', { preHandler: veryLongCacheHandler }, async (request, reply) => {
    try {
      const query = `
        SELECT
          name,
          description,
          member_count,
          floor_price_wei,
          floor_price_currency,
          total_sales_count,
          total_sales_volume_wei,
          last_floor_update,
          last_sales_update,
          created_at,
          updated_at
        FROM clubs
        ORDER BY member_count DESC, name ASC
      `;

      const result = await pool.query(query);

      const response: APIResponse = {
        success: true,
        data: {
          clubs: result.rows,
          total: result.rows.length,
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
        error: 'Failed to fetch clubs',
      });
    }
  });

  // Get names in a specific club
  fastify.get('/:clubName', { preHandler: cacheHandler }, async (request, reply) => {
    const { clubName } = request.params as { clubName: string };
    const { page = '1', limit = '20' } = request.query as { page?: string; limit?: string };

    try {
      // Get club info
      const clubQuery = `
        SELECT
          name,
          description,
          member_count,
          floor_price_wei,
          floor_price_currency,
          total_sales_count,
          total_sales_volume_wei,
          last_floor_update,
          last_sales_update,
          created_at
        FROM clubs
        WHERE name = $1
      `;
      const clubResult = await pool.query(clubQuery, [clubName]);

      if (clubResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'Club not found',
        });
      }

      const club = clubResult.rows[0];

      // Search for names in this club using the search service
      const searchResults = await searchNames({
        q: '*',
        page: parseInt(page),
        limit: parseInt(limit),
        filters: {
          clubs: [clubName],
        },
      });

      const response: APIResponse = {
        success: true,
        data: {
          club,
          names: searchResults.results,
          pagination: searchResults.pagination,
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
        error: 'Failed to fetch club names',
      });
    }
  });
}
