import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

export async function poapRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/poap/claim
   * Claim a POAP link (one per user)
   * Requires authentication
   */
  fastify.post('/claim', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }

    const userId = parseInt(request.user.sub);

    try {
      // Start a transaction to ensure atomicity
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Check if user has already claimed a POAP
        const existingClaim = await client.query(
          'SELECT id, link, claimed_at FROM poap_links WHERE claimant_id = $1',
          [userId]
        );

        if (existingClaim.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.status(400).send({
            success: false,
            error: {
              code: 'ALREADY_CLAIMED',
              message: 'You have already claimed a POAP',
              details: {
                claimed_at: existingClaim.rows[0].claimed_at,
                link: existingClaim.rows[0].link,
              },
            },
            meta: {
              timestamp: new Date().toISOString(),
              version: '1.0.0',
            },
          });
        }

        // Select one unclaimed link and mark it as claimed
        // Use SELECT FOR UPDATE to lock the row and prevent race conditions
        const claimResult = await client.query(
          `UPDATE poap_links
           SET claimed = TRUE,
               claimant_id = $1,
               claimed_at = NOW(),
               updated_at = NOW()
           WHERE id = (
             SELECT id FROM poap_links
             WHERE claimed = FALSE
             ORDER BY id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, link, claimed_at`,
          [userId]
        );

        if (claimResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: {
              code: 'NO_LINKS_AVAILABLE',
              message: 'No POAP links available at this time',
            },
            meta: {
              timestamp: new Date().toISOString(),
              version: '1.0.0',
            },
          });
        }

        await client.query('COMMIT');

        const claimedLink = claimResult.rows[0];

        fastify.log.info({
          userId,
          poapLinkId: claimedLink.id,
          claimedAt: claimedLink.claimed_at,
        }, 'User claimed POAP link');

        const response: APIResponse<{ link: string; claimed_at: string }> = {
          success: true,
          data: {
            link: claimedLink.link,
            claimed_at: claimedLink.claimed_at,
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        };

        return reply.send(response);

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error: any) {
      fastify.log.error({
        error: error.message,
        userId,
      }, 'Failed to claim POAP link');

      return reply.status(500).send({
        success: false,
        error: {
          code: 'CLAIM_FAILED',
          message: 'Failed to claim POAP link',
          details: error.message,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }
  });

  /**
   * GET /api/v1/poap/status
   * Check if current user has claimed a POAP
   * Requires authentication
   */
  fastify.get('/status', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }

    const userId = parseInt(request.user.sub);

    try {
      const result = await pool.query(
        'SELECT id, link, claimed_at FROM poap_links WHERE claimant_id = $1',
        [userId]
      );

      const hasClaimed = result.rows.length > 0;

      const response: APIResponse<{
        has_claimed: boolean;
        claimed_at?: string;
        link?: string;
      }> = {
        success: true,
        data: {
          has_claimed: hasClaimed,
          ...(hasClaimed && {
            claimed_at: result.rows[0].claimed_at,
            link: result.rows[0].link,
          }),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);

    } catch (error: any) {
      fastify.log.error({
        error: error.message,
        userId,
      }, 'Failed to check POAP status');

      return reply.status(500).send({
        success: false,
        error: {
          code: 'STATUS_CHECK_FAILED',
          message: 'Failed to check POAP status',
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }
  });

  /**
   * GET /api/v1/poap/stats
   * Get POAP statistics (total, claimed, remaining)
   * Public endpoint
   */
  fastify.get('/stats', async (request, reply) => {
    try {
      const result = await pool.query(
        `SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE claimed = TRUE) as claimed,
          COUNT(*) FILTER (WHERE claimed = FALSE) as remaining
         FROM poap_links`
      );

      const stats = result.rows[0];

      const response: APIResponse<{
        total: number;
        claimed: number;
        remaining: number;
      }> = {
        success: true,
        data: {
          total: parseInt(stats.total),
          claimed: parseInt(stats.claimed),
          remaining: parseInt(stats.remaining),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);

    } catch (error: any) {
      fastify.log.error({
        error: error.message,
      }, 'Failed to get POAP stats');

      return reply.status(500).send({
        success: false,
        error: {
          code: 'STATS_FAILED',
          message: 'Failed to get POAP statistics',
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }
  });
}
