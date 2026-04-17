import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, tierIdToName, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { getActiveSubscribers } from '../services/subscribers';
import { getQueueClient, QUEUE_NAMES } from '../queue';

const ChannelEnum = z.enum(['in_app', 'email', 'telegram']);

const BroadcastComposeSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  linkUrl: z.string().url().optional(),
  channels: z.array(ChannelEnum).min(1),
});

const BroadcastSendSchema = BroadcastComposeSchema.extend({
  minTierId: z.number().int().min(1).max(3),
});

const BroadcastPreviewSchema = z.object({
  minTierId: z.number().int().min(1).max(3),
  channels: z.array(ChannelEnum).min(1),
});

const GrantSubscriptionSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  durationDays: z.number().int().min(1).max(3650),
  tierId: z.number().int().min(1).optional().default(1),
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

        const tierName = tierIdToName(body.tierId);

        // Insert subscription record
        await client.query(
          `INSERT INTO user_subscriptions
           (user_id, tier, tier_id, status, started_at, expires_at, payment_method, granted_by, notes)
           VALUES ($1, $2, $3, 'active', NOW(), $4, 'admin_grant', $5, $6)`,
          [userId, tierName, body.tierId, expiresAt, adminUserId, body.notes || null]
        );

        // Update denormalized user fields
        await client.query(
          `UPDATE users SET tier = $2, tier_id = $3, tier_expires_at = $4 WHERE id = $1`,
          [userId, tierName, body.tierId, expiresAt]
        );

        await client.query('COMMIT');

        const response: APIResponse = {
          success: true,
          data: {
            userId,
            address: normalizedAddress,
            tier: tierName,
            tierId: body.tierId,
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
          `UPDATE users SET tier = 'free', tier_id = 0, tier_expires_at = NULL WHERE id = $1`,
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
         WHERE us.tier_id > 0 ${statusFilter}
         ORDER BY us.created_at DESC
         LIMIT $1 OFFSET $2`,
        params
      );

      const countParams: any[] = [];
      const countStatusFilter = status ? `AND status = $1` : '';
      if (status) countParams.push(status);

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM user_subscriptions
         WHERE tier_id > 0 ${countStatusFilter}`,
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

  /**
   * POST /api/v1/admin/notifications/preview
   * Returns recipient counts for a given tier floor + channel set.
   */
  fastify.post(
    '/notifications/preview',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { minTierId, channels } = BroadcastPreviewSchema.parse(request.body);
      const subs = await getActiveSubscribers(minTierId);

      const reachable = subs.filter((s) => {
        if (channels.includes('in_app')) return true;
        if (channels.includes('email') && s.emailVerified && s.email) return true;
        if (channels.includes('telegram') && s.telegramConnected && s.telegramChatId) return true;
        return false;
      });

      const byChannel = {
        in_app: channels.includes('in_app') ? subs.length : 0,
        email: channels.includes('email')
          ? subs.filter((s) => s.emailVerified && s.email).length
          : 0,
        telegram: channels.includes('telegram')
          ? subs.filter((s) => s.telegramConnected && s.telegramChatId).length
          : 0,
      };

      const response: APIResponse = {
        success: true,
        data: { totalRecipients: reachable.length, byChannel },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      };
      return reply.send(response);
    }
  );

  /**
   * POST /api/v1/admin/notifications/test
   * Send a preview notification to the calling admin only.
   */
  fastify.post(
    '/notifications/test',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const payload = BroadcastComposeSchema.parse(request.body);
      const adminUserId = parseInt(request.user!.sub);

      const inserted = await pool.query(
        `INSERT INTO admin_broadcasts
         (title, body, link_url, min_tier_id, channels, recipient_count, sent_by_user_id, is_test)
         VALUES ($1, $2, $3, 0, $4, 1, $5, TRUE)
         RETURNING id`,
        [
          payload.title,
          payload.body,
          payload.linkUrl || null,
          JSON.stringify(payload.channels),
          adminUserId,
        ]
      );
      const broadcastId = inserted.rows[0].id;

      const boss = await getQueueClient();
      await boss.send(QUEUE_NAMES.SEND_ADMIN_BROADCAST, {
        broadcastId,
        userId: adminUserId,
        channels: payload.channels,
        title: payload.title,
        body: payload.body,
        linkUrl: payload.linkUrl,
      });

      const response: APIResponse = {
        success: true,
        data: { broadcastId },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      };
      return reply.send(response);
    }
  );

  /**
   * POST /api/v1/admin/notifications/broadcast
   * Fan-out a custom notification to all paid subscribers at tier >= minTierId
   * via the requested channels.
   */
  fastify.post(
    '/notifications/broadcast',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const payload = BroadcastSendSchema.parse(request.body);
      const adminUserId = parseInt(request.user!.sub);

      const subs = await getActiveSubscribers(payload.minTierId);
      const recipients = subs.filter((s) => {
        if (payload.channels.includes('in_app')) return true;
        if (payload.channels.includes('email') && s.emailVerified && s.email) return true;
        if (payload.channels.includes('telegram') && s.telegramConnected && s.telegramChatId) return true;
        return false;
      });

      const client = await pool.connect();
      let broadcastId: number;
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO admin_broadcasts
           (title, body, link_url, min_tier_id, channels, recipient_count, sent_by_user_id, is_test)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
           RETURNING id`,
          [
            payload.title,
            payload.body,
            payload.linkUrl || null,
            payload.minTierId,
            JSON.stringify(payload.channels),
            recipients.length,
            adminUserId,
          ]
        );
        broadcastId = inserted.rows[0].id;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      if (recipients.length > 0) {
        const boss = await getQueueClient();
        const jobs = recipients.map((r) => ({
          name: QUEUE_NAMES.SEND_ADMIN_BROADCAST,
          data: {
            broadcastId,
            userId: r.userId,
            channels: payload.channels,
            title: payload.title,
            body: payload.body,
            linkUrl: payload.linkUrl,
          },
        }));
        await boss.insert(jobs);
      }

      const response: APIResponse = {
        success: true,
        data: { broadcastId, enqueued: recipients.length },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      };
      return reply.send(response);
    }
  );

  /**
   * GET /api/v1/admin/notifications
   * List history of admin broadcasts, newest first.
   */
  fastify.get(
    '/notifications',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { page = 1, limit = 25 } = request.query as any;
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      const rows = await pool.query(
        `SELECT ab.id, ab.title, ab.body, ab.link_url, ab.min_tier_id,
                ab.channels, ab.recipient_count, ab.is_test, ab.created_at,
                u.address AS sent_by_address
         FROM admin_broadcasts ab
         LEFT JOIN users u ON ab.sent_by_user_id = u.id
         ORDER BY ab.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limitNum, offset]
      );
      const countResult = await pool.query(`SELECT COUNT(*) FROM admin_broadcasts`);
      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / limitNum);

      const response: APIResponse = {
        success: true,
        data: {
          broadcasts: rows.rows,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages,
            hasNext: pageNum < totalPages,
            hasPrev: pageNum > 1,
          },
        },
        meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
      };
      return reply.send(response);
    }
  );
}
