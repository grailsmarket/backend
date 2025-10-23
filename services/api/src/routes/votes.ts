import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth, optionalAuth } from '../middleware/auth';

const CastVoteSchema = z.object({
  ensName: z.string().min(1),
  vote: z.number().int().min(-1).max(1), // -1 = downvote, 0 = remove vote, 1 = upvote
});

const LeaderboardQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['upvotes', 'netScore', 'downvotes']).default('netScore'),
});

export async function votesRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/votes
   * Cast or update vote for an ENS name
   */
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { ensName, vote } = CastVoteSchema.parse(request.body);
      const userId = parseInt(request.user.sub);

      // Resolve ENS name to ens_name_id
      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)',
        [ensName]
      );

      if (ensResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: `ENS name "${ensName}" not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const ensNameId = ensResult.rows[0].id;

      // Upsert vote (insert or update)
      const voteResult = await pool.query(
        `INSERT INTO name_votes (ens_name_id, user_id, vote)
         VALUES ($1, $2, $3)
         ON CONFLICT (ens_name_id, user_id)
         DO UPDATE SET vote = EXCLUDED.vote, updated_at = NOW()
         RETURNING *`,
        [ensNameId, userId, vote]
      );

      const voteRecord = voteResult.rows[0];

      // Fetch updated vote counts for this name
      const countsResult = await pool.query(
        `SELECT upvotes, downvotes, net_score
         FROM ens_names
         WHERE id = $1`,
        [ensNameId]
      );

      const counts = countsResult.rows[0];

      const response: APIResponse = {
        success: true,
        data: {
          vote: {
            id: voteRecord.id,
            ensNameId: voteRecord.ens_name_id,
            userId: voteRecord.user_id,
            vote: voteRecord.vote,
            createdAt: voteRecord.created_at,
            updatedAt: voteRecord.updated_at,
          },
          voteCounts: {
            upvotes: counts.upvotes,
            downvotes: counts.downvotes,
            netScore: counts.net_score,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error casting vote:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to cast vote',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/votes/:ensName
   * Get vote statistics for an ENS name
   */
  fastify.get('/:ensName', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      const { ensName } = request.params as { ensName: string };
      const userId = request.user ? parseInt(request.user.sub) : null;

      // Get ENS name and vote counts
      const nameResult = await pool.query(
        `SELECT id, name, upvotes, downvotes, net_score
         FROM ens_names
         WHERE LOWER(name) = LOWER($1)`,
        [ensName]
      );

      if (nameResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'ENS_NAME_NOT_FOUND',
            message: `ENS name "${ensName}" not found`,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const name = nameResult.rows[0];

      // Get user's vote if authenticated
      let userVote = null;
      if (userId) {
        const userVoteResult = await pool.query(
          `SELECT vote FROM name_votes
           WHERE ens_name_id = $1 AND user_id = $2`,
          [name.id, userId]
        );

        if (userVoteResult.rows.length > 0) {
          userVote = userVoteResult.rows[0].vote;
        }
      }

      const response: APIResponse = {
        success: true,
        data: {
          ensName: name.name,
          upvotes: name.upvotes || 0,
          downvotes: name.downvotes || 0,
          netScore: name.net_score || 0,
          userVote,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching vote stats:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch vote statistics',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/votes/leaderboard
   * Get leaderboard of top voted names
   */
  fastify.get('/leaderboard', async (request, reply) => {
    try {
      const { page, limit, sortBy } = LeaderboardQuerySchema.parse(request.query);
      const offset = (page - 1) * limit;

      // Map sortBy to column name
      const sortColumn = sortBy === 'netScore' ? 'net_score' :
                        sortBy === 'upvotes' ? 'upvotes' :
                        'downvotes';

      // Get total count
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM ens_names WHERE upvotes > 0 OR downvotes > 0'
      );
      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / limit);

      // Get leaderboard
      const leaderboardResult = await pool.query(
        `SELECT
          id,
          name,
          token_id,
          owner_address,
          upvotes,
          downvotes,
          net_score,
          (
            SELECT json_build_object(
              'id', l.id,
              'price_wei', l.price_wei,
              'currency_address', l.currency_address,
              'status', l.status,
              'source', l.source
            )
            FROM listings l
            WHERE l.ens_name_id = ens_names.id AND l.status = 'active'
            ORDER BY l.created_at DESC
            LIMIT 1
          ) as active_listing
         FROM ens_names
         WHERE upvotes > 0 OR downvotes > 0
         ORDER BY ${sortColumn} DESC, name ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const response: APIResponse = {
        success: true,
        data: {
          leaderboard: leaderboardResult.rows.map((row) => ({
            id: row.id,
            name: row.name,
            tokenId: row.token_id,
            ownerAddress: row.owner_address,
            upvotes: row.upvotes || 0,
            downvotes: row.downvotes || 0,
            netScore: row.net_score || 0,
            activeListing: row.active_listing,
          })),
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching leaderboard:', error);

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch leaderboard',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
