import type { FastifyInstance } from 'fastify';
import { getPostgresPool } from '../../../shared/src';
import { leaderboardCacheHandler } from '../middleware/cache';
import { getLeaderboard } from '../controllers/leaderboard';

export async function leaderboardRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // Get user leaderboard - ranks users by ENS name holdings
  // GET /api/v1/leaderboard
  fastify.get('/', { preHandler: leaderboardCacheHandler }, async (request, reply) => {
    return getLeaderboard(request, reply, pool);
  });
}
