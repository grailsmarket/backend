import type { FastifyInstance } from 'fastify';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

export async function subscriptionRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/subscription
   * Current subscription status
   */
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const userId = parseInt(request.user.sub);

    const userResult = await pool.query(
      'SELECT tier, tier_expires_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const user = userResult.rows[0];

    // Get latest active subscription
    const subResult = await pool.query(
      `SELECT * FROM user_subscriptions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY expires_at DESC NULLS LAST
       LIMIT 1`,
      [userId]
    );

    const response: APIResponse = {
      success: true,
      data: {
        tier: user.tier,
        tierExpiresAt: user.tier_expires_at,
        subscription: subResult.rows[0] || null,
      },
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });

  /**
   * GET /api/v1/subscription/history
   * Subscription history
   */
  fastify.get('/history', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const userId = parseInt(request.user.sub);
    const { page = 1, limit = 20 } = request.query as any;
    const offset = (page - 1) * limit;

    const [subsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM user_subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      pool.query(
        'SELECT COUNT(*) FROM user_subscriptions WHERE user_id = $1',
        [userId]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        subscriptions: subsResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });

  /**
   * GET /api/v1/subscription/price
   * Current subscription price (public endpoint)
   */
  fastify.get('/price', async (request, reply) => {
    // Return static pricing info — actual on-chain price fetched by frontend
    const response: APIResponse = {
      success: true,
      data: {
        pricePerDayWei: '1000000000000000', // 0.001 ETH per day default
        currency: 'ETH',
        description: 'Grails PRO subscription price per day',
      },
      meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
    };

    return reply.send(response);
  });
}
