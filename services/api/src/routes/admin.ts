import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  getAllBroadcastRecipients,
  getRecipientsByAddresses,
  getUnverifiedEmailRecipients,
  type BroadcastRecipient,
} from '../services/broadcast-recipients';
import { getQueueClient, QUEUE_NAMES } from '../queue';

const ChannelEnum = z.enum(['in_app', 'email', 'telegram']);

const BroadcastComposeSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  linkUrl: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
  channels: z.array(ChannelEnum).min(1),
});

// Phase 1: 'everyone' and 'specific'. Phase 2 adds 'unsubscribed' and 'tiers'.
const AudienceSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('everyone') }),
    z.object({
      type: z.literal('specific'),
      addresses: z
        .array(z.string().regex(/^0x[a-fA-F0-9]{40}$/))
        .min(1)
        .max(500),
    }),
    z.object({ type: z.literal('unverified_email') }),
  ])
  .default({ type: 'everyone' });

const BroadcastSendSchema = BroadcastComposeSchema.extend({
  audience: AudienceSchema,
});

const BroadcastPreviewSchema = z.object({
  channels: z.array(ChannelEnum).min(1),
  audience: AudienceSchema,
});

type Audience = z.infer<typeof AudienceSchema>;

async function resolveAudience(audience: Audience): Promise<BroadcastRecipient[]> {
  switch (audience.type) {
    case 'everyone':
      return getAllBroadcastRecipients();
    case 'specific':
      return getRecipientsByAddresses(audience.addresses);
    case 'unverified_email':
      return getUnverifiedEmailRecipients();
  }
}

export async function adminRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/admin/notifications/preview
   * Returns recipient counts for the given channel set and audience filter.
   */
  fastify.post(
    '/notifications/preview',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { channels, audience } = BroadcastPreviewSchema.parse(request.body);
      const recipients = await resolveAudience(audience);

      const reachable = recipients.filter((r) => {
        if (channels.includes('in_app')) return true;
        if (channels.includes('email') && r.emailVerified && r.email) return true;
        // telegram: no reachable recipients on this deployment yet
        return false;
      });

      const byChannel = {
        in_app: channels.includes('in_app') ? recipients.length : 0,
        email: channels.includes('email')
          ? recipients.filter((r) => r.emailVerified && r.email).length
          : 0,
        telegram: 0,
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
         (title, body, link_url, image_url, min_tier_id, channels, recipient_count, sent_by_user_id, is_test)
         VALUES ($1, $2, $3, $4, 0, $5, 1, $6, TRUE)
         RETURNING id`,
        [
          payload.title,
          payload.body,
          payload.linkUrl || null,
          payload.imageUrl || null,
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
        imageUrl: payload.imageUrl,
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
   * Fan-out a custom notification to the selected audience via the requested channels.
   * min_tier_id stays 0 — superseded by the audience_* columns.
   */
  fastify.post(
    '/notifications/broadcast',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const payload = BroadcastSendSchema.parse(request.body);
      const adminUserId = parseInt(request.user!.sub);

      const targeted = await resolveAudience(payload.audience);
      const recipients = targeted.filter((r) => {
        if (payload.channels.includes('in_app')) return true;
        if (payload.channels.includes('email') && r.emailVerified && r.email) return true;
        return false;
      });

      const audienceAddresses =
        payload.audience.type === 'specific' ? payload.audience.addresses : null;

      const client = await pool.connect();
      let broadcastId: number;
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO admin_broadcasts
           (title, body, link_url, image_url, min_tier_id, channels, recipient_count, sent_by_user_id, is_test,
            audience_type, audience_addresses)
           VALUES ($1, $2, $3, $4, 0, $5, $6, $7, FALSE, $8, $9)
           RETURNING id`,
          [
            payload.title,
            payload.body,
            payload.linkUrl || null,
            payload.imageUrl || null,
            JSON.stringify(payload.channels),
            recipients.length,
            adminUserId,
            payload.audience.type,
            audienceAddresses ? JSON.stringify(audienceAddresses) : null,
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
            imageUrl: payload.imageUrl,
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
        `SELECT ab.id, ab.title, ab.body, ab.link_url, ab.image_url, ab.min_tier_id,
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
