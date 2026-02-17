import type { FastifyInstance } from 'fastify';
import { getPostgresPool } from '../../../shared/src';
import { leaderboardCacheHandler } from '../middleware/cache';
import { getLeaderboard } from '../controllers/leaderboard';

export async function leaderboardRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // Get user leaderboard - ranks users by ENS name holdings
  // GET /api/v1/leaderboard
  // Query parameters:
  //   - page: Page number (default: 1)
  //   - limit: Items per page (default: 20, max: 100)
  //   - sortBy: Field to sort by (names_owned, names_in_clubs, expired_names, names_listed, names_sold, sales_volume)
  //   - sortOrder: Sort order (asc, desc) (default: desc)
  //   - clubs[]: Filter by clubs (optional, can be multiple)
  fastify.get('/', { preHandler: leaderboardCacheHandler }, async (request, reply) => {
    return getLeaderboard(request, reply, pool);
  });
}
