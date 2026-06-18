import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPostgresPool,
  uploadFile,
  deleteFile,
  isStorageEnabled,
  type APIResponse,
} from '../../../shared/src';
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
  type GlobalChatConfig,
} from '../services/global-chat';
import { callerIsBannedFromGlobalChat } from '../services/chat-moderation';
import {
  notifyReplyAndMentions,
  validateReplyTarget,
  REPLY_TO_PREVIEW_SELECT,
  REPLY_TO_JOINS,
} from '../services/chat-notifications';
import {
  parseImageUpload,
  buildChatImageKey,
  chatImageUrl,
  withAttachmentUrl,
  ATTACHMENT_SELECT,
  MAX_IMAGE_BYTES,
} from '../services/chat-images';
import { broadcastNotificationBump } from './websocket';

// Advisory-lock namespace for per-user global chat quota serialization
// (pg_advisory_xact_lock(namespace, user_id)). Arbitrary but must not collide
// with other advisory-lock namespaces in this codebase.
const GLOBAL_CHAT_QUOTA_LOCK_NS = 7301;

const SendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  reply_to_message_id: z.string().uuid().optional(),
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
        // Image feature flags (the kill switch is a global master, so clients can
        // use it to gate the image button in DMs too) + the upload size cap.
        images_enabled: config.images_enabled,
        max_image_bytes: MAX_IMAGE_BYTES,
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

      // Identity (primary name + avatar) is resolved client-side per address,
      // same as DM chats — the backend only ships sender_address.
      const result = await pool.query(
        `SELECT m.id, m.chat_id, m.sender_user_id, m.body, m.content_type,
                m.metadata, m.created_at, m.edited_at, m.deleted_at, m.deleted_by,
                u.address AS sender_address,${REPLY_TO_PREVIEW_SELECT},
                ${ATTACHMENT_SELECT},
                COALESCE(r.reactions, '[]'::json) AS reactions
           FROM messages m
           JOIN users u ON u.id = m.sender_user_id${REPLY_TO_JOINS}
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

      // Don't leak the raw deleter id publicly; expose only the admin-vs-author
      // distinction. deleted_by === author → self-delete ("by user"); a different
      // deleter → admin moderation ("by Admin").
      const messages = result.rows.map(({ deleted_by, ...m }) => withAttachmentUrl({
        ...m,
        body: m.deleted_at ? null : m.body,
        deleted_by_admin: !!m.deleted_at && deleted_by != null && deleted_by !== m.sender_user_id,
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
   * Shared core for sending a global-chat message (text or image). Enforces the
   * enabled flag, length, ban, reply-target validity, and the per-tier daily
   * quota, then inserts the message (+ optional attachment) atomically. Returns
   * a discriminated result so the HTTP routes can map success/failure.
   *
   * The quota check + insert must be atomic or two concurrent sends can both
   * pass the check (TOCTOU). Under READ COMMITTED, concurrent counts don't see
   * each other's uncommitted rows, so we serialize per user with a
   * transaction-scoped advisory lock (safe under PgBouncer transaction pooling).
   */
  type CreateGlobalResult =
    | { ok: true; message: any; quota: any }
    | { ok: false; status: number; code: string; message: string; details?: unknown };

  async function createGlobalMessage(params: {
    callerId: number;
    callerAddress: string;
    body: string; // text body, or image caption (may be empty)
    replyToMessageId: string | null;
    attachment: { storageKey: string; mimetype: string; byteSize: number } | null;
    config?: GlobalChatConfig;
  }): Promise<CreateGlobalResult> {
    const { callerId, callerAddress, body, replyToMessageId, attachment } = params;
    const config = params.config ?? (await getGlobalChatConfig());

    if (!config.enabled) {
      return { ok: false, status: 403, code: 'GLOBAL_CHAT_DISABLED', message: 'Global chat is currently disabled' };
    }
    if (body.length > config.max_message_length) {
      return {
        ok: false,
        status: 400,
        code: 'MESSAGE_TOO_LONG',
        message: `Message exceeds the maximum length of ${config.max_message_length} characters`,
      };
    }
    if (await callerIsBannedFromGlobalChat(pool, callerId)) {
      return { ok: false, status: 403, code: 'CHAT_BANNED', message: 'You are banned from messaging' };
    }

    // Reply target must be a live message in this room.
    let replyContext: Awaited<ReturnType<typeof validateReplyTarget>> = null;
    if (replyToMessageId) {
      replyContext = await validateReplyTarget(pool, GLOBAL_CHAT_ID, replyToMessageId);
      if (!replyContext) {
        return { ok: false, status: 400, code: 'INVALID_REPLY_TARGET', message: 'Reply target not found in this chat' };
      }
    }

    const tier = await getUserTier(callerAddress);
    const limit = tierLimit(tier, config);
    const contentType = attachment ? 'image' : 'text';

    // CTE: insert + join users so the response carries sender_address (the
    // frontend resolves identity from it, same as DMs). The 0859 trigger fires
    // pg_notify; ChatNotifier handles the WS fan-out. Always run inside a
    // transaction so the message + attachment commit atomically.
    const insertSql =
      `WITH new_msg AS (
         INSERT INTO messages (chat_id, sender_user_id, body, content_type, reply_to_message_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *
       )
       SELECT m.*, u.address AS sender_address
         FROM new_msg m
         JOIN users u ON u.id = m.sender_user_id`;
    const insertParams = [GLOBAL_CHAT_ID, callerId, body, contentType, replyToMessageId ?? null];

    let messageRow;
    let used = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (limit !== null) {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
          GLOBAL_CHAT_QUOTA_LOCK_NS,
          callerId,
        ]);
        used = await getQuotaUsedToday(callerId, client);
        if (used >= limit) {
          await client.query('ROLLBACK');
          return {
            ok: false,
            status: 429,
            code: 'QUOTA_EXCEEDED',
            message: 'Daily message limit reached',
            details: { tier, used, limit, remaining: 0, resets_at: nextUtcMidnight() },
          };
        }
      }
      const inserted = await client.query(insertSql, insertParams);
      messageRow = inserted.rows[0];
      if (attachment) {
        await client.query(
          `INSERT INTO message_attachments (message_id, chat_id, storage_key, content_type, byte_size)
           VALUES ($1, $2, $3, $4, $5)`,
          [messageRow.id, GLOBAL_CHAT_ID, attachment.storageKey, attachment.mimetype, attachment.byteSize]
        );
      }
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK').catch(() => {});
      throw txError;
    } finally {
      client.release();
    }

    const quota = {
      tier,
      used: limit === null ? 0 : used + 1,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used - 1),
      resets_at: nextUtcMidnight(),
    };

    // Fire reply/@-mention notifications out-of-band; never fail the send on it.
    // Global room → any resolved user may be notified (accessibleUserIds = null).
    try {
      const notified = await notifyReplyAndMentions({
        pool,
        chatId: GLOBAL_CHAT_ID,
        messageId: messageRow.id,
        senderUserId: callerId,
        senderAddress: callerAddress,
        body,
        replyToMessageId: replyToMessageId ?? null,
        replyParentAuthorId: replyContext?.parentAuthorId ?? null,
        accessibleUserIds: null,
      });
      broadcastNotificationBump(notified);
    } catch (notifyError) {
      fastify.log.error({ notifyError }, 'Error creating chat notifications (global send)');
    }

    // New messages have no reactions yet; include the empty aggregate so the
    // response shape matches GET /messages.
    const message: any = {
      ...messageRow,
      reactions: [],
      reply_to: replyContext?.replyTo ?? null,
      attachment: attachment
        ? {
            url: chatImageUrl(attachment.storageKey),
            content_type: attachment.mimetype,
            width: null,
            height: null,
            byte_size: attachment.byteSize,
            expired: false,
          }
        : null,
    };
    return { ok: true, message, quota };
  }

  /**
   * POST /api/v1/chats/global/messages
   * Send a text message to the global room. Daily quota by tier (ENS ownership).
   */
  fastify.post('/messages', {
    preHandler: requireAuth,
    config: {
      rateLimit: {
        // Admin-configurable via PATCH /chats/admin/global/config; the config
        // is Redis-cached (30s, invalidated on PATCH) so this per-request
        // lookup is cheap.
        max: async () => (await getGlobalChatConfig()).rate_limit_per_minute,
        timeWindow: 60_000,
      },
    },
  }, async (request, reply) => {
    try {
      const { body, reply_to_message_id } = SendMessageSchema.parse(request.body);
      const result = await createGlobalMessage({
        callerId: parseInt(request.user!.sub, 10),
        callerAddress: request.user!.address,
        body,
        replyToMessageId: reply_to_message_id ?? null,
        attachment: null,
      });
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message, result.details);
      }
      return reply.status(201).send(ok({ message: result.message, quota: result.quota }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error sending global chat message');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to send message');
    }
  });

  /**
   * POST /api/v1/chats/global/messages/image
   * Send an image message to the global room (multipart: `file` + optional
   * `body` caption + optional `reply_to_message_id`). Same enabled/ban/quota
   * enforcement as text sends; gated by the `images_enabled` master switch.
   */
  fastify.post('/messages/image', {
    preHandler: requireAuth,
    config: {
      rateLimit: {
        max: async () => (await getGlobalChatConfig()).rate_limit_per_minute,
        timeWindow: 60_000,
      },
    },
  }, async (request, reply) => {
    let uploadedKey: string | null = null;
    try {
      const callerId = parseInt(request.user!.sub, 10);
      const callerAddress = request.user!.address;

      const config = await getGlobalChatConfig();
      if (!config.enabled) {
        return sendError(reply, 403, 'GLOBAL_CHAT_DISABLED', 'Global chat is currently disabled');
      }
      if (!config.images_enabled) {
        return sendError(reply, 403, 'IMAGES_DISABLED', 'Image messages are currently disabled');
      }
      if (!isStorageEnabled()) {
        return sendError(reply, 503, 'STORAGE_UNAVAILABLE', 'Image storage is not configured');
      }
      // Cheap ban pre-check before consuming the upload (avoids a wasted write).
      if (await callerIsBannedFromGlobalChat(pool, callerId)) {
        return sendError(reply, 403, 'CHAT_BANNED', 'You are banned from messaging');
      }

      const parsed = await parseImageUpload(request);
      if ('error' in parsed) {
        const map: Record<string, [number, string, string]> = {
          NO_FILE: [400, 'NO_FILE', 'No image file provided'],
          FILE_TOO_LARGE: [413, 'FILE_TOO_LARGE', `Image exceeds the maximum size of ${MAX_IMAGE_BYTES} bytes`],
          UNSUPPORTED_TYPE: [400, 'UNSUPPORTED_TYPE', 'Unsupported image type (allowed: jpeg, png, gif, webp)'],
        };
        const [status, code, message] = map[parsed.error];
        return sendError(reply, status, code, message);
      }

      const caption = (parsed.fields.body ?? '').trim();
      const replyToRaw = parsed.fields.reply_to_message_id || null;
      if (replyToRaw && !z.string().uuid().safeParse(replyToRaw).success) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid reply_to_message_id');
      }
      if (caption.length > config.max_message_length) {
        return sendError(
          reply,
          400,
          'MESSAGE_TOO_LONG',
          `Caption exceeds the maximum length of ${config.max_message_length} characters`
        );
      }

      uploadedKey = buildChatImageKey(GLOBAL_CHAT_ID, parsed.ext);
      await uploadFile(uploadedKey, parsed.buffer, parsed.mimetype);

      const result = await createGlobalMessage({
        callerId,
        callerAddress,
        body: caption,
        replyToMessageId: replyToRaw,
        attachment: { storageKey: uploadedKey, mimetype: parsed.mimetype, byteSize: parsed.buffer.length },
        config,
      });
      if (!result.ok) {
        // The insert failed (e.g. quota) — don't orphan the uploaded object.
        await deleteFile(uploadedKey).catch(() => {});
        return sendError(reply, result.status, result.code, result.message, result.details);
      }
      return reply.status(201).send(ok({ message: result.message, quota: result.quota }));
    } catch (error: any) {
      if (uploadedKey) await deleteFile(uploadedKey).catch(() => {});
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error sending global chat image');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to send image');
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
   * Recently ACTIVE users (24h window), newest activity first. Activity =
   * users.last_seen_at (updated by ActivityLogger on every authenticated
   * request, 5-min throttle) falling back to last_sign_in (SIWE verify) —
   * sign-in alone is too rare a signal because JWT cookies persist for days.
   * Public; response is identical for everyone so it goes through the
   * Redis cache. Excludes stub users and banned users.
   */
  fastify.get('/online-users', { preHandler: withCache({ ttl: 15 }) }, async (request, reply) => {
    try {
      const { page, limit } = OnlineUsersQuerySchema.parse(request.query);
      const offset = (page - 1) * limit;

      // OR (instead of GREATEST in the WHERE) so the partial indexes on
      // last_seen_at and last_sign_in stay usable.
      const activeWhere = `
            (u.last_seen_at >= NOW() - INTERVAL '24 hours'
             OR u.last_sign_in >= NOW() - INTERVAL '24 hours')
            AND COALESCE(u.is_stub, FALSE) = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM chat_user_status s
               WHERE s.user_id = u.id
                 AND (s.status = 'banned' OR s.global_status = 'banned')
            )`;

      // Identity is resolved client-side per address (same as DM chats).
      const usersResult = await pool.query(
        `SELECT u.id AS user_id, u.address, u.last_sign_in,
                GREATEST(u.last_seen_at, u.last_sign_in::timestamptz) AS last_active
           FROM users u
          WHERE ${activeWhere}
          ORDER BY GREATEST(u.last_seen_at, u.last_sign_in::timestamptz) DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM users u
          WHERE ${activeWhere}`
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
