import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { withCache } from '../middleware/cache';
import {
  GLOBAL_CHAT_ID,
  getGlobalChatConfig,
  getGlobalQuotaSnapshot,
  getQuotaUsedToday,
  getUserTier,
  nextUtcMidnight,
  tierLimit,
} from '../services/global-chat';

const SendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

const ListMessagesQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const OnlineUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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

async function callerIsBannedFromChat(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM chat_user_status WHERE user_id = $1 AND status = 'banned' LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

export async function chatsGlobalRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/chats/global
   * Public room info (no quota fields — those are per-user via /quota).
   */
  fastify.get('/', { preHandler: withCache({ ttl: 15 }) }, async (_request, reply) => {
    try {
      const config = await getGlobalChatConfig();
      const chatResult = await pool.query(
        `SELECT title, last_message_at FROM chats WHERE id = $1`,
        [GLOBAL_CHAT_ID]
      );
      const chat = chatResult.rows[0];
      return reply.send(ok({
        chat_id: GLOBAL_CHAT_ID,
        title: chat?.title ?? 'Grails Chat',
        enabled: config.enabled,
        max_message_length: config.max_message_length,
        last_message_at: chat?.last_message_at ?? null,
      }));
    } catch (error) {
      fastify.log.error({ error }, 'Error fetching global chat info');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch global chat info');
    }
  });

  /**
   * GET /api/v1/chats/global/messages
   * Public read with cursor pagination (same shape as DM messages). When the
   * caller is authenticated, reaction aggregates include `reacted` for them.
   */
  fastify.get('/messages', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      const { before, limit } = ListMessagesQuerySchema.parse(request.query);
      const callerId = request.user ? parseInt(request.user.sub, 10) : null;

      let beforeCreatedAt: Date | null = null;
      if (before) {
        const cursor = await pool.query(
          `SELECT created_at FROM messages WHERE id = $1 AND chat_id = $2`,
          [before, GLOBAL_CHAT_ID]
        );
        if (cursor.rows.length === 0) {
          return sendError(reply, 400, 'INVALID_CURSOR', 'Cursor message not found in this chat');
        }
        beforeCreatedAt = cursor.rows[0].created_at;
      }

      const params: any[] = [GLOBAL_CHAT_ID, callerId, limit];
      let cursorClause = '';
      if (beforeCreatedAt) {
        params.push(beforeCreatedAt);
        cursorClause = `AND m.created_at < $${params.length}`;
      }

      const result = await pool.query(
        `SELECT m.id, m.chat_id, m.sender_user_id, m.body, m.content_type,
                m.metadata, m.created_at, m.edited_at, m.deleted_at,
                u.address AS sender_address,
                en.name AS sender_ens_name,
                en.avatar AS sender_avatar,
                COALESCE(r.reactions, '[]'::json) AS reactions
           FROM messages m
           JOIN users u ON u.id = m.sender_user_id
           LEFT JOIN LATERAL (
             SELECT e.name, e.metadata->>'avatar' AS avatar
               FROM ens_names e
              WHERE LOWER(e.owner_address) = LOWER(u.address)
              ORDER BY (COALESCE(e.metadata->>'avatar', '') <> '') DESC,
                       e.registration_date ASC NULLS LAST
              LIMIT 1
           ) en ON TRUE
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                      'emoji', agg.emoji,
                      'count', agg.cnt,
                      'reacted', agg.reacted
                    ) ORDER BY agg.cnt DESC, agg.emoji) AS reactions
               FROM (
                 SELECT emoji, COUNT(*)::int AS cnt,
                        COALESCE(BOOL_OR(user_id = $2), FALSE) AS reacted
                   FROM message_reactions
                  WHERE message_id = m.id
                  GROUP BY emoji
               ) agg
           ) r ON TRUE
          WHERE m.chat_id = $1 ${cursorClause}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $3`,
        params
      );

      const messages = result.rows.map((m) => ({
        ...m,
        body: m.deleted_at ? null : m.body,
      }));

      return reply.send(ok({
        messages,
        nextCursor: messages.length === limit ? messages[messages.length - 1].id : null,
      }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error listing global chat messages');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list messages');
    }
  });

  /**
   * POST /api/v1/chats/global/messages
   * Send a message to the global room. Daily quota by tier (ENS ownership).
   */
  fastify.post('/messages', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
  }, async (request, reply) => {
    try {
      const { body } = SendMessageSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);
      const callerAddress = request.user!.address;

      const config = await getGlobalChatConfig();
      if (!config.enabled) {
        return sendError(reply, 403, 'GLOBAL_CHAT_DISABLED', 'Global chat is currently disabled');
      }
      if (body.length > config.max_message_length) {
        return sendError(
          reply,
          400,
          'MESSAGE_TOO_LONG',
          `Message exceeds the maximum length of ${config.max_message_length} characters`
        );
      }

      if (await callerIsBannedFromChat(pool, callerId)) {
        return sendError(reply, 403, 'CHAT_BANNED', 'You are banned from messaging');
      }

      const tier = await getUserTier(callerAddress);
      const limit = tierLimit(tier, config);
      let used = 0;
      if (limit !== null) {
        used = await getQuotaUsedToday(callerId);
        if (used >= limit) {
          return sendError(reply, 429, 'QUOTA_EXCEEDED', 'Daily message limit reached', {
            tier,
            used,
            limit,
            remaining: 0,
            resets_at: nextUtcMidnight(),
          });
        }
      }

      // CTE: insert + join users/ens_names so the response carries the same
      // display fields as list reads. The 0859 trigger fires pg_notify;
      // ChatNotifier handles the WS fan-out.
      const inserted = await pool.query(
        `WITH new_msg AS (
           INSERT INTO messages (chat_id, sender_user_id, body, content_type)
           VALUES ($1, $2, $3, 'text')
           RETURNING *
         )
         SELECT m.*, u.address AS sender_address,
                en.name AS sender_ens_name,
                en.avatar AS sender_avatar
           FROM new_msg m
           JOIN users u ON u.id = m.sender_user_id
           LEFT JOIN LATERAL (
             SELECT e.name, e.metadata->>'avatar' AS avatar
               FROM ens_names e
              WHERE LOWER(e.owner_address) = LOWER(u.address)
              ORDER BY (COALESCE(e.metadata->>'avatar', '') <> '') DESC,
                       e.registration_date ASC NULLS LAST
              LIMIT 1
           ) en ON TRUE`,
        [GLOBAL_CHAT_ID, callerId, body]
      );

      const quota = {
        tier,
        used: limit === null ? 0 : used + 1,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - used - 1),
        resets_at: nextUtcMidnight(),
      };

      return reply.status(201).send(ok({ message: inserted.rows[0], quota }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error sending global chat message');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to send message');
    }
  });

  /**
   * GET /api/v1/chats/global/quota
   * The caller's tier and remaining daily quota.
   */
  fastify.get('/quota', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const callerId = parseInt(request.user!.sub, 10);
      const snapshot = await getGlobalQuotaSnapshot(callerId, request.user!.address);
      return reply.send(ok(snapshot));
    } catch (error) {
      fastify.log.error({ error }, 'Error fetching global chat quota');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch quota');
    }
  });

  /**
   * GET /api/v1/chats/global/online-users
   * Recently signed-in users (24h window) ordered by last_sign_in DESC.
   * Public; response is identical for everyone so it goes through the
   * Redis cache. Excludes stub users and banned users.
   */
  fastify.get('/online-users', { preHandler: withCache({ ttl: 15 }) }, async (request, reply) => {
    try {
      const { page, limit } = OnlineUsersQuerySchema.parse(request.query);
      const offset = (page - 1) * limit;

      const usersResult = await pool.query(
        `SELECT u.id AS user_id, u.address, u.last_sign_in,
                en.name AS ens_name, en.avatar
           FROM users u
           LEFT JOIN LATERAL (
             SELECT e.name, e.metadata->>'avatar' AS avatar
               FROM ens_names e
              WHERE LOWER(e.owner_address) = LOWER(u.address)
              ORDER BY (COALESCE(e.metadata->>'avatar', '') <> '') DESC,
                       e.registration_date ASC NULLS LAST
              LIMIT 1
           ) en ON TRUE
          WHERE u.last_sign_in >= NOW() - INTERVAL '24 hours'
            AND COALESCE(u.is_stub, FALSE) = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM chat_user_status s
               WHERE s.user_id = u.id AND s.status = 'banned'
            )
          ORDER BY u.last_sign_in DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM users u
          WHERE u.last_sign_in >= NOW() - INTERVAL '24 hours'
            AND COALESCE(u.is_stub, FALSE) = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM chat_user_status s
               WHERE s.user_id = u.id AND s.status = 'banned'
            )`
      );
      const total = totalResult.rows[0].count;
      const totalPages = Math.ceil(total / limit);

      return reply.send(ok({
        users: usersResult.rows,
        pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
      }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', error.errors);
      }
      fastify.log.error({ error }, 'Error listing online users');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list online users');
    }
  });
}
