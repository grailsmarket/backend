import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';
import { broadcastChatReadEvent, broadcastChatDeletedEvent, broadcastChatCreatedEvent } from './websocket';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

const RecipientSchema = z.string().refine(
  (v) => ADDRESS_RE.test(v) || ENS_RE.test(v),
  { message: 'Recipient must be an Ethereum address or ENS name (.eth)' }
);

const CreateChatSchema = z.object({
  recipient: RecipientSchema.optional(),
  recipients: z.array(RecipientSchema).optional(),
}).refine(
  (v) => Boolean(v.recipient) !== Boolean(v.recipients && v.recipients.length),
  { message: 'Provide either `recipient` or non-empty `recipients`' }
);

const SendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

const MarkReadSchema = z.object({
  up_to_message_id: z.string().uuid(),
});

const PatchChatSchema = z.object({
  muted: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const ListMessagesQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const InboxQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ChatIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const ChatMessageIdParamsSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
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

/** Resolve a recipient (address or .eth name) to a users.id, creating a stub user if needed. */
async function resolveRecipientToUserId(
  pool: ReturnType<typeof getPostgresPool>,
  recipient: string
): Promise<{ userId: number; address: string } | { error: string }> {
  let address: string;

  if (ADDRESS_RE.test(recipient)) {
    address = recipient.toLowerCase();
  } else {
    const ensResult = await pool.query(
      `SELECT owner_address FROM ens_names WHERE LOWER(name) = LOWER($1)`,
      [recipient]
    );
    if (ensResult.rows.length === 0) {
      return { error: 'ENS name not found' };
    }
    const owner = ensResult.rows[0].owner_address as string | null;
    if (!owner) {
      return { error: 'ENS name has no owner' };
    }
    address = owner.toLowerCase();
  }

  const found = await pool.query(`SELECT id FROM users WHERE address = $1`, [address]);
  if (found.rows.length > 0) {
    return { userId: found.rows[0].id, address };
  }

  const created = await pool.query(
    `INSERT INTO users (address, is_stub) VALUES ($1, TRUE)
     ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address
     RETURNING id`,
    [address]
  );
  return { userId: created.rows[0].id, address };
}

function dmKeyForUserPair(a: number, b: number): string {
  // Defensive: coerce to numeric. If either id arrives as a string (e.g. from
  // a non-numeric JWT.sub or a pg driver quirk), `<` would fall back to string
  // comparison and produce non-symmetric keys like "10:2", breaking idempotency.
  const aNum = Number(a);
  const bNum = Number(b);
  if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) {
    throw new Error(`Invalid user ids for dm_key: a=${a}, b=${b}`);
  }
  const [lo, hi] = aNum < bNum ? [aNum, bNum] : [bNum, aNum];
  return `${lo}:${hi}`;
}

async function userIsParticipant(
  pool: ReturnType<typeof getPostgresPool>,
  chatId: string,
  userId: number
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [chatId, userId]
  );
  return r.rows.length > 0;
}

async function getChatParticipantUserIds(
  pool: ReturnType<typeof getPostgresPool>,
  chatId: string
): Promise<number[]> {
  const r = await pool.query(
    `SELECT user_id FROM chat_participants WHERE chat_id = $1 AND left_at IS NULL`,
    [chatId]
  );
  return r.rows.map((row) => row.user_id);
}

export async function chatsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * POST /api/v1/chats
   * Create or fetch a direct chat. Idempotent via dm_key.
   * v1: only direct (1:1). Groups respond 501.
   */
  fastify.post('/', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (request, reply) => {
    try {
      const body = CreateChatSchema.parse(request.body);
      const recipients = body.recipients ?? [body.recipient!];

      if (recipients.length > 1) {
        return sendError(reply, 501, 'NOT_IMPLEMENTED', 'Group chats are not supported in v1');
      }

      const callerId = parseInt(request.user!.sub, 10);
      if (!Number.isFinite(callerId)) {
        fastify.log.error({ sub: request.user!.sub }, 'POST /chats: non-numeric JWT sub');
        return sendError(reply, 401, 'INVALID_TOKEN', 'Authenticated user id is invalid');
      }

      // Confirm the caller's user row actually exists before we try to use the
      // id as a foreign key. In normal operation SIWE verify committed it before
      // the JWT was issued, but if the row was deleted between sign-in and now
      // (or the JWT is stale), the chat_participants insert below would fail
      // with a confusing FK violation. Surface a clearer error instead.
      const callerCheck = await pool.query(
        `SELECT 1 FROM users WHERE id = $1`,
        [callerId]
      );
      if (callerCheck.rows.length === 0) {
        fastify.log.error({ callerId }, 'POST /chats: caller user row missing');
        return sendError(reply, 401, 'USER_NOT_FOUND', 'Your user record was not found — please sign in again');
      }

      const resolved = await resolveRecipientToUserId(pool, recipients[0]);
      if ('error' in resolved) {
        return sendError(reply, 404, 'RECIPIENT_NOT_FOUND', resolved.error);
      }
      if (resolved.userId === callerId) {
        return sendError(reply, 400, 'SELF_CHAT_FORBIDDEN', 'Cannot start a chat with yourself');
      }

      const blockCheck = await pool.query(
        `SELECT 1 FROM message_blocks
          WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
             OR (blocker_user_id = $2 AND blocked_user_id = $1)
          LIMIT 1`,
        [callerId, resolved.userId]
      );
      if (blockCheck.rows.length > 0) {
        return sendError(reply, 403, 'BLOCKED', 'Messaging is blocked between these users');
      }

      const recipientPrefs = await pool.query(
        `SELECT accept_messages FROM users WHERE id = $1`,
        [resolved.userId]
      );
      if (recipientPrefs.rows.length === 0 || recipientPrefs.rows[0].accept_messages === false) {
        return sendError(reply, 403, 'RECIPIENT_OPTED_OUT', 'Recipient is not accepting messages');
      }

      const dmKey = dmKeyForUserPair(callerId, resolved.userId);

      // Idempotent insert via dm_key unique index.
      const insertResult = await pool.query(
        `INSERT INTO chats (type, dm_key, created_by_user_id)
         VALUES ('direct', $1, $2)
         ON CONFLICT (dm_key) DO NOTHING
         RETURNING *`,
        [dmKey, callerId]
      );

      let chat;
      let isNew = false;
      if (insertResult.rows.length > 0) {
        chat = insertResult.rows[0];
        isNew = true;
        // Insert two participants on first creation
        await pool.query(
          `INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2), ($1, $3)
           ON CONFLICT DO NOTHING`,
          [chat.id, callerId, resolved.userId]
        );
      } else {
        const existing = await pool.query(`SELECT * FROM chats WHERE dm_key = $1`, [dmKey]);
        chat = existing.rows[0];
      }

      if (isNew) {
        // Notify the other participant that they're in a new chat (if they're connected).
        broadcastChatCreatedEvent({ chat, participantUserIds: [callerId, resolved.userId] });
      }

      return reply.status(isNew ? 201 : 200).send(ok({ chat, created: isNew }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request body', error.errors);
      }
      // Translate common Postgres errors so the frontend can show something
      // meaningful and so we can diagnose without server-log access.
      // 23503 = foreign_key_violation, 23505 = unique_violation, 23514 = check_violation
      const pgCode = error?.code as string | undefined;
      const detail = error?.detail as string | undefined;
      fastify.log.error({ error, pgCode, detail }, 'Error creating chat');
      if (pgCode === '23503') {
        return sendError(
          reply,
          409,
          'FOREIGN_KEY_VIOLATION',
          'Could not create chat: referenced user no longer exists',
          { detail }
        );
      }
      if (pgCode === '23505') {
        return sendError(reply, 409, 'CONFLICT', 'A conflicting chat row already exists', { detail });
      }
      const message = error?.message ? `Failed to create chat: ${error.message}` : 'Failed to create chat';
      return sendError(reply, 500, 'INTERNAL_ERROR', message, { pgCode, detail });
    }
  });

  /**
   * GET /api/v1/chats
   * Caller's inbox: chats with most-recent-message preview and unread count.
   */
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { page, limit } = InboxQuerySchema.parse(request.query);
      const offset = (page - 1) * limit;
      const callerId = parseInt(request.user!.sub, 10);

      const inbox = await pool.query(
        `WITH my_chats AS (
           SELECT c.*, cp.last_read_message_id, cp.muted
             FROM chats c
             JOIN chat_participants cp ON cp.chat_id = c.id
            WHERE cp.user_id = $1 AND cp.left_at IS NULL
         )
         SELECT
           mc.*,
           (
             SELECT row_to_json(lm) FROM (
               SELECT id, sender_user_id, body, content_type, created_at, deleted_at
                 FROM messages
                WHERE chat_id = mc.id AND deleted_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
             ) lm
           ) AS last_message,
           (
             SELECT COUNT(*) FROM messages m
              WHERE m.chat_id = mc.id
                AND m.deleted_at IS NULL
                AND m.sender_user_id <> $1
                AND (
                  mc.last_read_message_id IS NULL
                  OR m.created_at > (SELECT created_at FROM messages WHERE id = mc.last_read_message_id)
                )
           )::int AS unread_count,
           (
             SELECT COALESCE(json_agg(json_build_object(
               'user_id', cp2.user_id,
               'address', u.address,
               'role', cp2.role,
               'joined_at', cp2.joined_at,
               'left_at', cp2.left_at,
               'last_read_message_id', cp2.last_read_message_id
             ) ORDER BY cp2.joined_at), '[]'::json)
               FROM chat_participants cp2
               JOIN users u ON u.id = cp2.user_id
              WHERE cp2.chat_id = mc.id
           ) AS participants
         FROM my_chats mc
         ORDER BY mc.last_message_at DESC NULLS LAST, mc.created_at DESC
         LIMIT $2 OFFSET $3`,
        [callerId, limit, offset]
      );

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM chat_participants
          WHERE user_id = $1 AND left_at IS NULL`,
        [callerId]
      );
      const total = totalResult.rows[0].count;
      const totalPages = Math.ceil(total / limit);

      return reply.send(ok({
        chats: inbox.rows,
        pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
      }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', error.errors);
      }
      fastify.log.error({ error }, 'Error listing chats');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list chats');
    }
  });

  /**
   * GET /api/v1/chats/:id
   * Chat detail with all participants and their read state. Only accessible to participants.
   */
  fastify.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { id } = ChatIdParamsSchema.parse(request.params);
      const callerId = parseInt(request.user!.sub, 10);

      if (!(await userIsParticipant(pool, id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      const chatResult = await pool.query(
        `SELECT
           c.*,
           (
             SELECT json_agg(json_build_object(
               'user_id', cp.user_id,
               'address', u.address,
               'role', cp.role,
               'joined_at', cp.joined_at,
               'left_at', cp.left_at,
               'muted', cp.muted,
               'last_read_message_id', cp.last_read_message_id
             ) ORDER BY cp.joined_at)
               FROM chat_participants cp
               JOIN users u ON u.id = cp.user_id
              WHERE cp.chat_id = c.id
           ) AS participants
         FROM chats c
         WHERE c.id = $1`,
        [id]
      );

      return reply.send(ok({ chat: chatResult.rows[0] }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid chat id', error.errors);
      }
      fastify.log.error({ error }, 'Error fetching chat');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch chat');
    }
  });

  /**
   * PATCH /api/v1/chats/:id
   * Update caller's per-chat state (mute toggle).
   */
  fastify.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { id } = ChatIdParamsSchema.parse(request.params);
      const updates = PatchChatSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);

      if (!(await userIsParticipant(pool, id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      if (updates.muted !== undefined) {
        await pool.query(
          `UPDATE chat_participants SET muted = $1 WHERE chat_id = $2 AND user_id = $3`,
          [updates.muted, id, callerId]
        );
      }

      return reply.send(ok({ chat_id: id, muted: updates.muted }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error updating chat');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update chat');
    }
  });

  /**
   * GET /api/v1/chats/:id/messages
   * Cursor-paginated messages (newest first). `before` = message id; returns messages older than it.
   */
  fastify.get('/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { id } = ChatIdParamsSchema.parse(request.params);
      const { before, limit } = ListMessagesQuerySchema.parse(request.query);
      const callerId = parseInt(request.user!.sub, 10);

      if (!(await userIsParticipant(pool, id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      let beforeCreatedAt: Date | null = null;
      if (before) {
        const cursor = await pool.query(
          `SELECT created_at FROM messages WHERE id = $1 AND chat_id = $2`,
          [before, id]
        );
        if (cursor.rows.length === 0) {
          return sendError(reply, 400, 'INVALID_CURSOR', 'Cursor message not found in this chat');
        }
        beforeCreatedAt = cursor.rows[0].created_at;
      }

      const params: any[] = [id, limit];
      let cursorClause = '';
      if (beforeCreatedAt) {
        params.push(beforeCreatedAt);
        cursorClause = `AND m.created_at < $${params.length}`;
      }

      const result = await pool.query(
        `SELECT m.id, m.chat_id, m.sender_user_id, m.body, m.content_type,
                m.metadata, m.created_at, m.edited_at, m.deleted_at,
                u.address AS sender_address
           FROM messages m
           JOIN users u ON u.id = m.sender_user_id
          WHERE m.chat_id = $1 ${cursorClause}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2`,
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
      fastify.log.error({ error }, 'Error listing messages');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list messages');
    }
  });

  /**
   * POST /api/v1/chats/:id/messages
   * Send a message in an existing chat.
   * Enforcement: caller is participant; nobody in chat has blocked caller; all other
   * participants have accept_messages = TRUE.
   */
  fastify.post('/:id/messages', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (request, reply) => {
    try {
      const { id } = ChatIdParamsSchema.parse(request.params);
      const { body } = SendMessageSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);

      const others = await pool.query(
        `SELECT cp.user_id, u.accept_messages
           FROM chat_participants cp
           JOIN users u ON u.id = cp.user_id
          WHERE cp.chat_id = $1 AND cp.left_at IS NULL`,
        [id]
      );
      const callerInChat = others.rows.find((r) => r.user_id === callerId);
      if (!callerInChat) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }
      const otherIds = others.rows.filter((r) => r.user_id !== callerId).map((r) => r.user_id);

      if (otherIds.length > 0) {
        const blocked = await pool.query(
          `SELECT 1 FROM message_blocks
            WHERE blocker_user_id = ANY($1::int[]) AND blocked_user_id = $2
            LIMIT 1`,
          [otherIds, callerId]
        );
        if (blocked.rows.length > 0) {
          return sendError(reply, 403, 'BLOCKED', 'You are blocked from messaging this chat');
        }

        const allAccept = others.rows
          .filter((r) => r.user_id !== callerId)
          .every((r) => r.accept_messages !== false);
        if (!allAccept) {
          return sendError(reply, 403, 'RECIPIENT_OPTED_OUT', 'A recipient is not accepting messages');
        }
      }

      // CTE: insert + join users so we return sender_address alongside the row.
      // Without this, the frontend's optimistic-replace step loses sender_address
      // and renders the message on the wrong side until the next refresh.
      const inserted = await pool.query(
        `WITH new_msg AS (
           INSERT INTO messages (chat_id, sender_user_id, body, content_type)
           VALUES ($1, $2, $3, 'text')
           RETURNING *
         )
         SELECT m.*, u.address AS sender_address
           FROM new_msg m
           JOIN users u ON u.id = m.sender_user_id`,
        [id, callerId, body]
      );

      // Trigger fires pg_notify; ChatNotifier handles fan-out. Nothing else to do here.
      return reply.status(201).send(ok({ message: inserted.rows[0] }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error sending message');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to send message');
    }
  });

  /**
   * POST /api/v1/chats/:id/read
   * Mark messages as read up to the given message id. Broadcasts chat:read to other participants.
   */
  fastify.post('/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { id } = ChatIdParamsSchema.parse(request.params);
      const { up_to_message_id } = MarkReadSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);

      if (!(await userIsParticipant(pool, id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      // Validate that the message belongs to the chat
      const msgCheck = await pool.query(
        `SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2`,
        [up_to_message_id, id]
      );
      if (msgCheck.rows.length === 0) {
        return sendError(reply, 400, 'INVALID_MESSAGE', 'Message does not belong to this chat');
      }

      await pool.query(
        `UPDATE chat_participants SET last_read_message_id = $1
          WHERE chat_id = $2 AND user_id = $3`,
        [up_to_message_id, id, callerId]
      );

      const participantIds = await getChatParticipantUserIds(pool, id);
      broadcastChatReadEvent({
        chatId: id,
        userId: callerId,
        lastReadMessageId: up_to_message_id,
        participantUserIds: participantIds,
      });

      return reply.send(ok({ chat_id: id, last_read_message_id: up_to_message_id }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error marking read');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to mark read');
    }
  });

  /**
   * DELETE /api/v1/chats/:id/messages/:messageId
   * Soft-delete caller's own message.
   */
  fastify.delete('/:id/messages/:messageId', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { id, messageId } = ChatMessageIdParamsSchema.parse(request.params);
      const callerId = parseInt(request.user!.sub, 10);

      const result = await pool.query(
        `UPDATE messages SET deleted_at = NOW()
          WHERE id = $1 AND chat_id = $2 AND sender_user_id = $3 AND deleted_at IS NULL
          RETURNING id`,
        [messageId, id, callerId]
      );
      if (result.rows.length === 0) {
        // Either not found, not in chat, not the sender, or already deleted.
        return sendError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found or not deletable');
      }

      const participantIds = await getChatParticipantUserIds(pool, id);
      broadcastChatDeletedEvent({
        chatId: id,
        messageId,
        participantUserIds: participantIds,
      });

      return reply.send(ok({ chat_id: id, message_id: messageId, deleted: true }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error deleting message');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to delete message');
    }
  });
}

