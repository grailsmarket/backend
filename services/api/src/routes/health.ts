import { FastifyInstance } from 'fastify';
import { getPostgresPool, getElasticsearchClient } from '../../../shared/src';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
    };
  });

  fastify.get('/ready', async (request, reply) => {
    const checks = {
      postgres: false,
      elasticsearch: false,
    };

    try {
      const pgPool = getPostgresPool();
      await pgPool.query('SELECT 1');
      checks.postgres = true;
    } catch (error) {
      request.log.error({ error }, 'PostgreSQL health check failed');
    }

    try {
      const es = getElasticsearchClient();
      await es.ping();
      checks.elasticsearch = true;
    } catch (error) {
      request.log.error({ error }, 'Elasticsearch health check failed');
    }

    const allHealthy = Object.values(checks).every(check => check);

    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? 'ready' : 'not ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}