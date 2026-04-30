import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

const BlockTargetSchema = z.object({
  user: z.string().refine(
    (v) => ADDRESS_RE.test(v) || ENS_RE.test(v),
    { message: 'Target must be an Ethereum address or ENS name (.eth)' }
  ),
});

const UserIdParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

const sendError = (reply: any, status: number, code: string, message: string, details?: unknown) =>
  reply.status(status).send({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    meta: { timestamp: new Date().toISOString() },
  });

const ok = <T>(data: T): APIResponse<T> => ({
  success: true,
  data,
  meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
});

async function resolveTargetToUserId(
  pool: ReturnType<typeof getPostgresPool>,
  target: string
): Promise<{ userId: number; address: string } | { error: string }> {
  let address: string;

  if (ADDRESS_RE.test(target)) {
    address = target.toLowerCase();
  } else {
    const ensResult = await pool.query(
      `SELECT owner_address FROM ens_names WHERE LOWER(name) = LOWER($1)`,
      [target]
    );
    const owner = ensResult.rows[0]?.owner_address as string | null | undefined;
    if (!owner) {
      return { error: 'ENS name not found' };
    }
    address = owner.toLowerCase();
  }

  const found = await pool.query(`SELECT id FROM users WHERE address = $1`, [address]);
  if (found.rows.length > 0) {
    return { userId: found.rows[0].id, address };
  }

  // Allow blocking users who don't have a real account yet — create a stub.
  const created = await pool.query(
    `INSERT INTO users (address, is_stub) VALUES ($1, TRUE)
     ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address
     RETURNING id`,
    [address]
  );
  return { userId: created.rows[0].id, address };
}

export async function blocksRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/me/blocks
   * List the caller's blocked users.
   */
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const callerId = parseInt(request.user!.sub, 10);
      const result = await pool.query(
        `SELECT mb.blocked_user_id AS user_id, u.address, mb.created_at
           FROM message_blocks mb
           JOIN users u ON u.id = mb.blocked_user_id
          WHERE mb.blocker_user_id = $1
          ORDER BY mb.created_at DESC`,
        [callerId]
      );
      return reply.send(ok({ blocks: result.rows }));
    } catch (error) {
      fastify.log.error({ error }, 'Error listing blocks');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list blocks');
    }
  });

  /**
   * POST /api/v1/me/blocks
   * Block a user (by address or ENS name).
   */
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { user } = BlockTargetSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);
      const resolved = await resolveTargetToUserId(pool, user);
      if ('error' in resolved) {
        return sendError(reply, 404, 'TARGET_NOT_FOUND', resolved.error);
      }
      if (resolved.userId === callerId) {
        return sendError(reply, 400, 'SELF_BLOCK_FORBIDDEN', 'Cannot block yourself');
      }

      await pool.query(
        `INSERT INTO message_blocks (blocker_user_id, blocked_user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [callerId, resolved.userId]
      );

      return reply.status(201).send(ok({
        blocker_user_id: callerId,
        blocked_user_id: resolved.userId,
        address: resolved.address,
      }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error creating block');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to create block');
    }
  });

  /**
   * DELETE /api/v1/me/blocks/:userId
   * Unblock a user.
   */
  fastify.delete('/:userId', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { userId } = UserIdParamsSchema.parse(request.params);
      const callerId = parseInt(request.user!.sub, 10);

      const result = await pool.query(
        `DELETE FROM message_blocks
          WHERE blocker_user_id = $1 AND blocked_user_id = $2
          RETURNING blocked_user_id`,
        [callerId, userId]
      );
      if (result.rows.length === 0) {
        return sendError(reply, 404, 'BLOCK_NOT_FOUND', 'No such block');
      }
      return reply.send(ok({ blocker_user_id: callerId, blocked_user_id: userId }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error removing block');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to remove block');
    }
  });
}
