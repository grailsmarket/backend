import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin } from '../middleware/auth';

const GrantSubscriptionSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  durationDays: z.number().int().min(1).max(3650),
  notes: z.string().optional(),
});

const RevokeSubscriptionSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  notes: z.string().optional(),
});

export async function adminRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/admin/subscriptions/grant
   * Manually grant PRO to a user
   */
  fastify.post(
    '/subscriptions/grant',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const body = GrantSubscriptionSchema.parse(request.body);
      const normalizedAddress = body.address.toLowerCase();
      const adminUserId = parseInt(request.user!.sub);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Upsert user
        const userResult = await client.query(
          `INSERT INTO users (address) VALUES ($1)
           ON CONFLICT (address) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [normalizedAddress]
        );
        const userId = userResult.rows[0].id;

        // Calculate expiry
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + body.durationDays);

        // Insert subscription record
        await client.query(
          `INSERT INTO user_subscriptions
           (user_id, tier, status, started_at, expires_at, payment_method, granted_by, notes)
           VALUES ($1, 'pro', 'active', NOW(), $2, 'admin_grant', $3, $4)`,
          [userId, expiresAt, adminUserId, body.notes || null]
        );

        // Update denormalized user fields
        await client.query(
          `UPDATE users SET tier = 'pro', tier_expires_at = $2 WHERE id = $1`,
          [userId, expiresAt]
        );

        await client.query('COMMIT');

        const response: APIResponse = {
          success: true,
          data: {
            userId,
            address: normalizedAddress,
            tier: 'pro',
            expiresAt: expiresAt.toISOString(),
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.status(201).send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * POST /api/v1/admin/subscriptions/revoke
   * Revoke PRO from a user
   */
  fastify.post(
    '/subscriptions/revoke',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const body = RevokeSubscriptionSchema.parse(request.body);
      const normalizedAddress = body.address.toLowerCase();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Find user
        const userResult = await client.query(
          'SELECT id FROM users WHERE address = $1',
          [normalizedAddress]
        );

        if (userResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'USER_NOT_FOUND', message: 'User not found' },
            meta: { timestamp: new Date().toISOString() },
          });
        }

        const userId = userResult.rows[0].id;

        // Cancel active subscriptions
        await client.query(
          `UPDATE user_subscriptions
           SET status = 'cancelled', cancelled_at = NOW(), notes = COALESCE(notes || ' | ', '') || $2
           WHERE user_id = $1 AND status = 'active'`,
          [userId, body.notes || 'Admin revoke']
        );

        // Downgrade user
        await client.query(
          `UPDATE users SET tier = 'free', tier_expires_at = NULL WHERE id = $1`,
          [userId]
        );

        await client.query('COMMIT');

        const response: APIResponse = {
          success: true,
          data: {
            userId,
            address: normalizedAddress,
            tier: 'free',
          },
          meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
        };

        return reply.send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  /**
   * GET /api/v1/admin/subscriptions
   * List all subscribers
   */
  fastify.get(
    '/subscriptions',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { page = 1, limit = 50, status } = request.query as any;
      const offset = (page - 1) * limit;

      const statusFilter = status ? `AND us.status = $3` : '';
      const params: any[] = [limit, offset];
      if (status) params.push(status);

      const subsResult = await pool.query(
        `SELECT us.*, u.address
         FROM user_subscriptions us
         JOIN users u ON us.user_id = u.id
         WHERE us.tier = 'pro' ${statusFilter}
         ORDER BY us.created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      );

      const countParams: any[] = [];
      const countStatusFilter = status ? `AND status = $1` : '';
      if (status) countParams.push(status);

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM user_subscriptions
         WHERE tier = 'pro' ${countStatusFilter}`,
        countParams
      );

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
    }
  );
}
