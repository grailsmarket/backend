import type { FastifyInstance } from 'fastify';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { getQueueClient } from '../queue';

export async function personasRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/personas
   * List all personas (public)
   */
  fastify.get('/', async (_request, reply) => {
    try {
      const result = await pool.query(
        `SELECT slug, name, description, icon,
                default_filters_all_names,
                default_filters_listings,
                default_filters_sales,
                default_filters_registrations,
                default_filters_offers
         FROM personas
         ORDER BY priority DESC`
      );

      const response: APIResponse = {
        success: true,
        data: result.rows.map((row) => ({
          slug: row.slug,
          name: row.name,
          description: row.description,
          icon: row.icon,
          defaultFilters: {
            allNames: row.default_filters_all_names,
            listings: row.default_filters_listings,
            sales: row.default_filters_sales,
            registrations: row.default_filters_registrations,
            offers: row.default_filters_offers,
          },
        })),
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching personas:', error);
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch personas' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * GET /api/v1/personas/me
   * Get current user's persona with default filters and scores
   */
  fastify.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const address = request.user!.address.toLowerCase();

      const result = await pool.query(
        `SELECT
           p.slug,
           p.name,
           p.description,
           p.icon,
           p.default_filters_all_names,
           p.default_filters_listings,
           p.default_filters_sales,
           p.default_filters_registrations,
           p.default_filters_offers,
           u.persona_scores,
           u.persona_classified_at
         FROM users u
         LEFT JOIN personas p ON p.id = u.persona_id
         WHERE u.address = $1`,
        [address]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const row = result.rows[0];

      // User hasn't been classified yet
      if (!row.slug) {
        const defaultResult = await pool.query(
          `SELECT slug, name, description, icon,
                  default_filters_all_names, default_filters_listings,
                  default_filters_sales, default_filters_registrations,
                  default_filters_offers
           FROM personas WHERE is_default = TRUE LIMIT 1`
        );

        const defaultPersona = defaultResult.rows[0];

        const response: APIResponse = {
          success: true,
          data: {
            persona: defaultPersona ? {
              slug: defaultPersona.slug,
              name: defaultPersona.name,
              description: defaultPersona.description,
              icon: defaultPersona.icon,
            } : null,
            defaultFilters: defaultPersona ? {
              allNames: defaultPersona.default_filters_all_names,
              listings: defaultPersona.default_filters_listings,
              sales: defaultPersona.default_filters_sales,
              registrations: defaultPersona.default_filters_registrations,
              offers: defaultPersona.default_filters_offers,
            } : {},
            scores: null,
            classifiedAt: null,
          },
          meta: { timestamp: new Date().toISOString() },
        };

        return reply.send(response);
      }

      const response: APIResponse = {
        success: true,
        data: {
          persona: {
            slug: row.slug,
            name: row.name,
            description: row.description,
            icon: row.icon,
          },
          defaultFilters: {
            allNames: row.default_filters_all_names,
            listings: row.default_filters_listings,
            sales: row.default_filters_sales,
            registrations: row.default_filters_registrations,
            offers: row.default_filters_offers,
          },
          scores: row.persona_scores,
          classifiedAt: row.persona_classified_at,
        },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching user persona:', error);
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch persona' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/personas/me/reclassify
   * Queue a reclassification job for the current user
   */
  fastify.post('/me/reclassify', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const address = request.user!.address.toLowerCase();

      const boss = await getQueueClient();
      const jobId = await boss.send('classify-personas', { addresses: [address] });

      const response: APIResponse = {
        success: true,
        data: { jobId, message: 'Reclassification queued' },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error queuing reclassification:', error);
      return reply.status(500).send({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to queue reclassification' },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });
}
