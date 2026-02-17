import type { FastifyInstance } from 'fastify';
import { config } from '../../../shared/src';

export async function subgraphRoutes(fastify: FastifyInstance) {
  // Relay endpoint for ENS subgraph queries
  // POST /api/v1/subgraph
  // Accepts GraphQL queries and forwards them to the private ENSNode instance
  fastify.post('/', async (request, reply) => {
    try {
      const subgraphUrl = config.theGraph.ensSubgraphUrl;

      if (!subgraphUrl) {
        return reply.status(503).send({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'ENS subgraph relay is not configured',
          },
        });
      }

      // Get the request body (should be a GraphQL query)
      const body = request.body;

      if (!body || typeof body !== 'object') {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Request body must be a valid GraphQL query object',
          },
        });
      }

      // Forward the request to the subgraph
      const response = await fetch(subgraphUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      // Get the response data
      const data = await response.json();

      // Return the response with the same status code
      return reply.status(response.status).send(data);
    } catch (error: any) {
      fastify.log.error({ error }, 'Subgraph relay request failed');

      return reply.status(502).send({
        success: false,
        error: {
          code: 'BAD_GATEWAY',
          message: 'Failed to relay request to ENS subgraph',
        },
      });
    }
  });
}
