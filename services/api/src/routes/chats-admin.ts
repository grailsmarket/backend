import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { expireMessageAttachments } from '../services/chat-images';
import { broadcastChatDeletedEvent, broadcastGlobalChatDeletedEvent } from './websocket';
import {
  GLOBAL_CHAT_ID,
  getGlobalChatConfig,
  invalidateGlobalChatConfigCache,
} from '../services/global-chat';

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

const UserIdParamsSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

const BanSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const UnbanSchema = z.object({
  reason: z.string().trim().max(500).optional().default(''),
});

const DeleteMessagesSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

interface ChatStatusRow {
  user_id: number;
  status: 'active' | 'banned';
  banned_at: Date | null;
  global_status: 'active' | 'banned';
  global_banned_at: Date | null;
  last_action_by: number | null;
  last_action_reason: string | null;
}

async function getChatModStatus(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number
): Promise<ChatStatusRow | null> {
  const r = await pool.query<ChatStatusRow>(
    `SELECT user_id, status, banned_at, global_status, global_banned_at,
            last_action_by, last_action_reason
       FROM chat_user_status WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? null;
}

/**
 * Global-chat-only ban: independent of the all-chats `status` column, which
 * the upsert deliberately leaves untouched.
 */
async function setGlobalChatStatus(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number,
  globalStatus: 'active' | 'banned',
  adminId: number,
  reason: string
): Promise<void> {
  const globalBannedAt = globalStatus === 'banned' ? new Date() : null;
  await pool.query(
    `INSERT INTO chat_user_status (user_id, global_status, global_banned_at, last_action_by, last_action_reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       global_status = EXCLUDED.global_status,
       global_banned_at = EXCLUDED.global_banned_at,
       last_action_by = EXCLUDED.last_action_by,
       last_action_reason = EXCLUDED.last_action_reason,
       updated_at = NOW()`,
    [userId, globalStatus, globalBannedAt, adminId, reason]
  );
}

async function setChatStatus(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number,
  status: 'active' | 'banned',
  adminId: number,
  reason: string
): Promise<void> {
  const bannedAt = status === 'banned' ? new Date() : null;
  await pool.query(
    `INSERT INTO chat_user_status (user_id, status, banned_at, last_action_by, last_action_reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       status = EXCLUDED.status,
       banned_at = EXCLUDED.banned_at,
       last_action_by = EXCLUDED.last_action_by,
       last_action_reason = EXCLUDED.last_action_reason,
       updated_at = NOW()`,
    [userId, status, bannedAt, adminId, reason]
  );
}

async function insertChatModNotification(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number,
  type:
    | 'chat_banned'
    | 'chat_unbanned'
    | 'chat_messages_deleted'
    | 'global_chat_banned'
    | 'global_chat_unbanned',
  metadata: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
     VALUES ($1, $2, NULL, $3, NOW())`,
    [userId, type, JSON.stringify(metadata)]
  );
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

const LookupQuerySchema = z.object({
  q: z.string().trim().min(1),
});

const GlobalMessagesQuerySchema = z.object({
  sender: z.string().trim().min(1).optional(), // 0x address or numeric users.id
  status: z.enum(['all', 'visible', 'deleted']).default('all'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const GlobalMessageIdParamsSchema = z.object({
  messageId: z.string().uuid(),
});

const DeleteGlobalMessageSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const GlobalConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  // null = unlimited for the avatar tier
  quota_with_avatar: z.number().int().min(0).nullable().optional(),
  quota_with_name: z.number().int().min(0).optional(),
  quota_without_name: z.number().int().min(0).optional(),
  max_message_length: z.number().int().min(1).max(4000).optional(),
  rate_limit_per_minute: z.number().int().min(1).max(600).optional(),
  // Master kill switch for image sending across all chats.
  images_enabled: z.boolean().optional(),
  // GLOBAL-only message cap; ALL-chats image expiry. Capped at ~10 years.
  message_retention_days: z.number().int().min(1).max(3650).optional(),
  image_retention_days: z.number().int().min(1).max(3650).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export async function chatsAdminRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/chats/admin/users/lookup?q=<address|ens>
   * Resolve an address or .eth name to a users.id so the admin UI can navigate
   * to the per-user moderation page. Returns 404 when the user has never been
   * recorded in the users table (no chats, no sign-in, no stub).
   */
  fastify.get(
    '/users/lookup',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { q } = LookupQuerySchema.parse(request.query);

        let address: string | null = null;
        if (ADDRESS_RE.test(q)) {
          address = q.toLowerCase();
        } else if (ENS_RE.test(q)) {
          const ensResult = await pool.query(
            `SELECT owner_address FROM ens_names WHERE LOWER(name) = LOWER($1)`,
            [q]
          );
          if (ensResult.rows.length === 0) {
            return sendError(reply, 404, 'ENS_NOT_FOUND', 'ENS name not found');
          }
          address = (ensResult.rows[0].owner_address as string | null)?.toLowerCase() ?? null;
          if (!address) {
            return sendError(reply, 404, 'ENS_NO_OWNER', 'ENS name has no owner');
          }
        } else {
          return sendError(reply, 400, 'INVALID_QUERY', 'Provide an address or .eth name');
        }

        const userResult = await pool.query(
          `SELECT id, address FROM users WHERE address = $1`,
          [address]
        );
        if (userResult.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'No user record for this address');
        }

        return reply.send(ok({ user: userResult.rows[0] }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error looking up user');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to look up user');
      }
    }
  );

  /**
   * GET /api/v1/chats/admin/users/:userId
   * Per-user chat moderation view: status, recent messages (incl. deleted), full mod log.
   */
  fastify.get(
    '/users/:userId',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = UserIdParamsSchema.parse(request.params);

        const userResult = await pool.query(
          `SELECT id, address, persona_id, email, created_at FROM users WHERE id = $1`,
          [userId]
        );
        if (userResult.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        const status = await getChatModStatus(pool, userId);

        const messageStats = await pool.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS visible,
             COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted
           FROM messages WHERE sender_user_id = $1`,
          [userId]
        );

        const recent = await pool.query(
          `SELECT id, chat_id, body, created_at, deleted_at
             FROM messages
            WHERE sender_user_id = $1
            ORDER BY created_at DESC
            LIMIT 100`,
          [userId]
        );

        const log = await pool.query(
          `SELECT id, action, reason, metadata, created_at, admin_id
             FROM chat_moderation_log
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 50`,
          [userId]
        );

        return reply.send(
          ok({
            user: userResult.rows[0],
            status: status ?? {
              user_id: userId,
              status: 'active',
              banned_at: null,
              global_status: 'active',
              global_banned_at: null,
              last_action_by: null,
              last_action_reason: null,
            },
            messageStats: messageStats.rows[0],
            messages: recent.rows,
            log: log.rows,
          })
        );
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error fetching chat user mod info');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch user');
      }
    }
  );

  /**
   * POST /api/v1/chats/admin/users/:userId/ban
   * Ban a user from sending or starting any chats.
   */
  fastify.post(
    '/users/:userId/ban',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = UserIdParamsSchema.parse(request.params);
        const { reason } = BanSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const target = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (target.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        await setChatStatus(pool, userId, 'banned', adminId, reason);

        await pool.query(
          `INSERT INTO chat_moderation_log (user_id, admin_id, action, reason)
           VALUES ($1, $2, 'ban', $3)`,
          [userId, adminId, reason]
        );

        await insertChatModNotification(pool, userId, 'chat_banned', { reason });

        return reply.send(ok({ userId, status: 'banned' }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error banning user from chat');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to ban user');
      }
    }
  );

  /**
   * POST /api/v1/chats/admin/users/:userId/unban
   * Restore messaging access.
   */
  fastify.post(
    '/users/:userId/unban',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = UserIdParamsSchema.parse(request.params);
        const { reason } = UnbanSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const target = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (target.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        await setChatStatus(pool, userId, 'active', adminId, reason);

        await pool.query(
          `INSERT INTO chat_moderation_log (user_id, admin_id, action, reason)
           VALUES ($1, $2, 'unban', $3)`,
          [userId, adminId, reason]
        );

        await insertChatModNotification(pool, userId, 'chat_unbanned', { reason });

        return reply.send(ok({ userId, status: 'active' }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error unbanning user from chat');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to unban user');
      }
    }
  );

  /**
   * POST /api/v1/chats/admin/users/:userId/delete-messages
   * Soft-delete every message the user has sent. Broadcasts chat:message_deleted
   * to connected clients per affected chat so live conversations update.
   */
  fastify.post(
    '/users/:userId/delete-messages',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = UserIdParamsSchema.parse(request.params);
        const { reason } = DeleteMessagesSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const target = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (target.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        const updated = await pool.query<{ id: string; chat_id: string }>(
          `UPDATE messages SET deleted_at = NOW(), deleted_by = $2, deleted_reason = $3
            WHERE sender_user_id = $1 AND deleted_at IS NULL
          RETURNING id, chat_id`,
          [userId, adminId, reason]
        );

        const messageIds = updated.rows.map((r) => r.id);
        const affectedChatIds = Array.from(new Set(updated.rows.map((r) => r.chat_id)));

        // Pull any attached images from the bucket now (best-effort).
        await expireMessageAttachments(pool, messageIds);

        await pool.query(
          `INSERT INTO chat_moderation_log (user_id, admin_id, action, reason, metadata)
           VALUES ($1, $2, 'delete_messages', $3, $4)`,
          [
            userId,
            adminId,
            reason,
            JSON.stringify({ count: updated.rowCount, chat_ids: affectedChatIds }),
          ]
        );

        if (updated.rowCount && updated.rowCount > 0) {
          // Notify the affected user once with a summary, not per-message.
          await insertChatModNotification(pool, userId, 'chat_messages_deleted', {
            count: updated.rowCount,
            reason,
          });

          // Fan out per-message deletion events so connected clients update live.
          // Group rows by chat to fetch participant lists once per chat.
          const byChat = new Map<string, string[]>();
          for (const row of updated.rows) {
            if (!byChat.has(row.chat_id)) byChat.set(row.chat_id, []);
            byChat.get(row.chat_id)!.push(row.id);
          }
          for (const [chatId, ids] of byChat.entries()) {
            // The global room has no participant rows; fan out to global subscribers.
            if (chatId === GLOBAL_CHAT_ID) {
              for (const messageId of ids) {
                broadcastGlobalChatDeletedEvent({ messageId, deletedByAdmin: true });
              }
              continue;
            }
            const partRes = await pool.query(
              `SELECT user_id FROM chat_participants WHERE chat_id = $1 AND left_at IS NULL`,
              [chatId]
            );
            const participantUserIds = partRes.rows.map((r: any) => r.user_id);
            for (const messageId of ids) {
              broadcastChatDeletedEvent({
                chatId,
                messageId,
                participantUserIds,
                deletedByAdmin: true,
              });
            }
          }
        }

        return reply.send(
          ok({
            userId,
            deletedCount: updated.rowCount ?? 0,
            affectedChatIds,
            messageIds,
          })
        );
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error deleting user chat messages');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to delete messages');
      }
    }
  );

  /**
   * GET /api/v1/chats/admin/global/messages
   * Paginated global chat messages for moderation. Filters: sender (address or
   * users.id), status (all|visible|deleted), from/to datetimes. Unlike public
   * reads, the raw body is returned even for deleted messages.
   */
  fastify.get(
    '/global/messages',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { sender, status, from, to, page, limit } =
          GlobalMessagesQuerySchema.parse(request.query);
        const offset = (page - 1) * limit;

        let senderUserId: number | null = null;
        if (sender) {
          if (ADDRESS_RE.test(sender)) {
            const userResult = await pool.query(
              `SELECT id FROM users WHERE address = $1`,
              [sender.toLowerCase()]
            );
            if (userResult.rows.length === 0) {
              return reply.send(ok({
                messages: [],
                pagination: { page, limit, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
              }));
            }
            senderUserId = userResult.rows[0].id;
          } else if (/^\d+$/.test(sender)) {
            senderUserId = parseInt(sender, 10);
          } else {
            return sendError(reply, 400, 'INVALID_SENDER', 'Sender must be an address or user id');
          }
        }

        const where: string[] = ['m.chat_id = $1'];
        const params: unknown[] = [GLOBAL_CHAT_ID];
        if (senderUserId !== null) {
          params.push(senderUserId);
          where.push(`m.sender_user_id = $${params.length}`);
        }
        if (from) {
          params.push(from);
          where.push(`m.created_at >= $${params.length}`);
        }
        if (to) {
          params.push(to);
          where.push(`m.created_at <= $${params.length}`);
        }
        if (status === 'visible') where.push('m.deleted_at IS NULL');
        if (status === 'deleted') where.push('m.deleted_at IS NOT NULL');

        const whereSql = where.join(' AND ');

        const countResult = await pool.query(
          `SELECT COUNT(*)::int AS count FROM messages m WHERE ${whereSql}`,
          params
        );
        const total = countResult.rows[0].count;
        const totalPages = Math.ceil(total / limit);

        params.push(limit, offset);
        const result = await pool.query(
          `SELECT m.id, m.chat_id, m.sender_user_id, m.body, m.created_at,
                  m.deleted_at, m.deleted_by, m.deleted_reason,
                  (m.deleted_at IS NOT NULL AND m.deleted_by IS NOT NULL
                     AND m.deleted_by <> m.sender_user_id) AS deleted_by_admin,
                  u.address AS sender_address,
                  (SELECT s.status FROM chat_user_status s WHERE s.user_id = m.sender_user_id)
                    AS sender_mod_status,
                  (SELECT s.global_status FROM chat_user_status s WHERE s.user_id = m.sender_user_id)
                    AS sender_global_status
             FROM messages m
             JOIN users u ON u.id = m.sender_user_id
            WHERE ${whereSql}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );

        return reply.send(ok({
          messages: result.rows,
          pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error listing global chat messages (admin)');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list messages');
      }
    }
  );

  /**
   * DELETE /api/v1/chats/admin/global/messages/:messageId
   * Soft-delete a single global chat message, log it, broadcast the deletion.
   */
  fastify.delete(
    '/global/messages/:messageId',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { messageId } = GlobalMessageIdParamsSchema.parse(request.params);
        const { reason } = DeleteGlobalMessageSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const updated = await pool.query<{ sender_user_id: number }>(
          `UPDATE messages SET deleted_at = NOW(), deleted_by = $3, deleted_reason = $4
            WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL
            RETURNING sender_user_id`,
          [messageId, GLOBAL_CHAT_ID, adminId, reason]
        );
        if (updated.rows.length === 0) {
          return sendError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found or already deleted');
        }

        // Pull any attached image from the bucket now (best-effort).
        await expireMessageAttachments(pool, [messageId]);

        await pool.query(
          `INSERT INTO chat_moderation_log (user_id, admin_id, action, reason, metadata)
           VALUES ($1, $2, 'delete_message', $3, $4)`,
          [
            updated.rows[0].sender_user_id,
            adminId,
            reason,
            JSON.stringify({ message_id: messageId }),
          ]
        );

        broadcastGlobalChatDeletedEvent({ messageId, deletedByAdmin: true });

        return reply.send(ok({ message_id: messageId, deleted: true }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error deleting global chat message');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to delete message');
      }
    }
  );

  /**
   * GET /api/v1/chats/admin/global/config
   */
  fastify.get(
    '/global/config',
    { preHandler: [requireAuth, requireAdmin] },
    async (_request, reply) => {
      try {
        const config = await getGlobalChatConfig();
        return reply.send(ok({ config }));
      } catch (error: unknown) {
        fastify.log.error({ error }, 'Error fetching global chat config');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch config');
      }
    }
  );

  /**
   * PATCH /api/v1/chats/admin/global/config
   * Partial update. quota_with_avatar accepts an explicit null (= unlimited),
   * so only `undefined` (absent) keys are skipped.
   */
  fastify.patch(
    '/global/config',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const updates = GlobalConfigPatchSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const cols: string[] = [];
        const params: unknown[] = [];
        let i = 0;
        for (const [k, v] of Object.entries(updates)) {
          if (v === undefined) continue;
          i += 1;
          cols.push(`${k} = $${i}`);
          params.push(v);
        }
        if (cols.length === 0) {
          return sendError(reply, 400, 'NO_FIELDS', 'No fields to update');
        }
        cols.push(`updated_at = NOW()`);

        await pool.query(
          `UPDATE global_chat_config SET ${cols.join(', ')} WHERE id = 1`,
          params
        );
        await invalidateGlobalChatConfigCache();

        await pool.query(
          `INSERT INTO chat_moderation_log (admin_id, action, reason, metadata)
           VALUES ($1, 'config_update', 'Global chat config patched', $2)`,
          [adminId, JSON.stringify(updates)]
        );

        const config = await getGlobalChatConfig();
        return reply.send(ok({ config }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error updating global chat config');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update config');
      }
    }
  );

  /**
   * POST /api/v1/chats/admin/global/users/:userId/ban
   * Ban a user from the GLOBAL CHAT ONLY (messages + reactions). DMs are
   * unaffected; independent of the all-chats ban (/users/:userId/ban).
   */
  fastify.post(
    '/global/users/:userId/ban',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = UserIdParamsSchema.parse(request.params);
        const { reason } = BanSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const target = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (target.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        await setGlobalChatStatus(pool, userId, 'banned', adminId, reason);

        await pool.query(
          `INSERT INTO chat_moderation_log (user_id, admin_id, action, reason)
           VALUES ($1, $2, 'global_ban', $3)`,
          [userId, adminId, reason]
        );

        await insertChatModNotification(pool, userId, 'global_chat_banned', { reason });

        return reply.send(ok({ userId, global_status: 'banned' }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error banning user from global chat');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to ban user');
      }
    }
  );

  /**
   * POST /api/v1/chats/admin/global/users/:userId/unban
   * Lift a global-chat-only ban. Does not touch an all-chats ban.
   */
  fastify.post(
    '/global/users/:userId/unban',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = UserIdParamsSchema.parse(request.params);
        const { reason } = UnbanSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const target = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (target.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        await setGlobalChatStatus(pool, userId, 'active', adminId, reason);

        await pool.query(
          `INSERT INTO chat_moderation_log (user_id, admin_id, action, reason)
           VALUES ($1, $2, 'global_unban', $3)`,
          [userId, adminId, reason]
        );

        await insertChatModNotification(pool, userId, 'global_chat_unbanned', { reason });

        return reply.send(ok({ userId, global_status: 'active' }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error unbanning user from global chat');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to unban user');
      }
    }
  );
}
