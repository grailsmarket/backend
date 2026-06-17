import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, optionalAuth } from '../middleware/auth';
import {
  broadcastChatReadEvent,
  broadcastChatDeletedEvent,
  broadcastChatEditedEvent,
  broadcastChatCreatedEvent,
  broadcastChatReactionEvent,
  broadcastGlobalChatDeletedEvent,
  broadcastGlobalChatEditedEvent,
  broadcastNotificationBump,
} from './websocket';
import { GLOBAL_CHAT_ID, getGlobalChatConfig } from '../services/global-chat';
import {
  callerIsBannedFromChat,
  callerIsBannedFromGlobalChat,
} from '../services/chat-moderation';
import {
  notifyReplyAndMentions,
  validateReplyTarget,
  REPLY_TO_PREVIEW_SELECT,
  REPLY_TO_JOINS,
} from '../services/chat-notifications';

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
  reply_to_message_id: z.string().uuid().optional(),
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

const SearchChatsQuerySchema = z.object({
  // Comma-separated, forward-resolved candidate addresses (from the client's ENS search).
  addresses: z.string().optional(),
  // Partial address for "0x…" typing.
  address_prefix: z.string().optional(),
});

const ChatIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const ChatMessageIdParamsSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
});

// A single emoji grapheme. 32 chars accommodates ZWJ family/skin-tone
// sequences; the pictographic check is deliberately permissive (regional
// indicators, keycaps) — the PK on (message_id, user_id, emoji) and the
// length cap bound abuse to distinct short strings.
const hasOnlyEmojiSafeChars = (v: string): boolean => {
  // No whitespace, control, surrogate, private-use or unassigned chars.
  if (/[\s\p{Cc}\p{Cs}\p{Co}\p{Cn}]/u.test(v)) return false;
  // Format chars (Cf) are rejected except ZWJ (U+200D), which emoji sequences need.
  const ZWJ = String.fromCodePoint(0x200d);
  for (const ch of v) {
    if (ch !== ZWJ && /\p{Cf}/u.test(ch)) return false;
  }
  return true;
};

const EmojiSchema = z.string().min(1).max(32)
  .refine(hasOnlyEmojiSafeChars, { message: 'Invalid emoji' })
  .refine(
    (v) =>
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\u{FE0F}?\u{20E3}/u.test(v),
    { message: 'Must be an emoji' }
  );

const AddReactionSchema = z.object({
  emoji: EmojiSchema,
});

const ReactionParamsSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  emoji: z.string().min(1),
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

  // Per-chat inbox row (last message preview, unread count, participants, block
  // flag). References $1 = caller user id and the `my_chats` CTE. Shared by the
  // inbox (GET /) and search (GET /search) queries so result rows render
  // identically; each supplies its own `my_chats` CTE + ORDER BY/LIMIT.
  const INBOX_ROW_SELECT = `
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
           ) AS participants,
           EXISTS (
             SELECT 1
               FROM message_blocks mb
               JOIN chat_participants cp_other ON cp_other.user_id = mb.blocked_user_id
              WHERE mb.blocker_user_id = $1
                AND cp_other.chat_id   = mc.id
                AND cp_other.user_id  <> $1
           ) AS is_blocked_by_me
         FROM my_chats mc`;

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

      if (await callerIsBannedFromChat(pool, callerId)) {
        return sendError(reply, 403, 'CHAT_BANNED', 'You are banned from messaging');
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
         ${INBOX_ROW_SELECT}
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
   * GET /api/v1/chats/search
   * Find the caller's DMs by counterparty. The frontend forward-resolves the
   * typed name to candidate addresses (ENS primary names are forward-verified,
   * so the resolved address is the chatting peer regardless of who owns the name
   * NFT) and passes them as `addresses`; `address_prefix` supports "0x…" typing.
   * Matches the peer's address, reusing the inbox row shape. Capped, unpaginated.
   * (Static path — resolves before GET /:id.)
   */
  fastify.get('/search', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const q = SearchChatsQuerySchema.parse(request.query);
      const callerId = parseInt(request.user!.sub, 10);

      const addresses = Array.from(
        new Set(
          (q.addresses ?? '')
            .split(',')
            .map((a) => a.trim().toLowerCase())
            .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
        )
      ).slice(0, 50);

      const rawPrefix = (q.address_prefix ?? '').trim().toLowerCase();
      const addressPrefix = /^0x[0-9a-f]{1,40}$/.test(rawPrefix) ? rawPrefix : null;

      // Nothing resolvable to match — don't scan the inbox.
      if (addresses.length === 0 && addressPrefix === null) {
        return reply.send(ok({ chats: [] }));
      }

      const result = await pool.query(
        `WITH my_chats AS (
           SELECT c.*, cp.last_read_message_id, cp.muted
             FROM chats c
             JOIN chat_participants cp ON cp.chat_id = c.id
            WHERE cp.user_id = $1 AND cp.left_at IS NULL
              AND EXISTS (
                SELECT 1 FROM chat_participants cpx
                  JOIN users ux ON ux.id = cpx.user_id
                 WHERE cpx.chat_id = c.id
                   AND cpx.user_id <> $1
                   AND (
                     LOWER(ux.address) = ANY($2::text[])
                     OR ($3::text IS NOT NULL AND LOWER(ux.address) LIKE $3 || '%')
                   )
              )
         )
         ${INBOX_ROW_SELECT}
         ORDER BY mc.last_message_at DESC NULLS LAST, mc.created_at DESC
         LIMIT 50`,
        [callerId, addresses, addressPrefix]
      );

      return reply.send(ok({ chats: result.rows }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', error.errors);
      }
      fastify.log.error({ error }, 'Error searching chats');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to search chats');
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
           ) AS participants,
           EXISTS (
             SELECT 1
               FROM message_blocks mb
               JOIN chat_participants cp_other ON cp_other.user_id = mb.blocked_user_id
              WHERE mb.blocker_user_id = $2
                AND cp_other.chat_id   = c.id
                AND cp_other.user_id  <> $2
           ) AS is_blocked_by_me
         FROM chats c
         WHERE c.id = $1`,
        [id, callerId]
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

      const params: any[] = [id, limit, callerId];
      let cursorClause = '';
      if (beforeCreatedAt) {
        params.push(beforeCreatedAt);
        cursorClause = `AND m.created_at < $${params.length}`;
      }

      const result = await pool.query(
        `SELECT m.id, m.chat_id, m.sender_user_id, m.body, m.content_type,
                m.metadata, m.created_at, m.edited_at, m.deleted_at, m.deleted_by,
                u.address AS sender_address,${REPLY_TO_PREVIEW_SELECT},
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
                        COALESCE(BOOL_OR(user_id = $3), FALSE) AS reacted
                   FROM message_reactions
                  WHERE message_id = m.id
                  GROUP BY emoji
               ) agg
           ) r ON TRUE
          WHERE m.chat_id = $1 ${cursorClause}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2`,
        params
      );

      // Don't leak the raw deleter id; expose only the admin-vs-author distinction.
      const messages = result.rows.map(({ deleted_by, ...m }) => ({
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
      const { body, reply_to_message_id } = SendMessageSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);

      if (await callerIsBannedFromChat(pool, callerId)) {
        return sendError(reply, 403, 'CHAT_BANNED', 'You are banned from messaging');
      }

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

      // Reply target must be a live message in this chat.
      let replyContext: Awaited<ReturnType<typeof validateReplyTarget>> = null;
      if (reply_to_message_id) {
        replyContext = await validateReplyTarget(pool, id, reply_to_message_id);
        if (!replyContext) {
          return sendError(reply, 400, 'INVALID_REPLY_TARGET', 'Reply target not found in this chat');
        }
      }

      // CTE: insert + join users so we return sender_address alongside the row.
      // Without this, the frontend's optimistic-replace step loses sender_address
      // and renders the message on the wrong side until the next refresh.
      const inserted = await pool.query(
        `WITH new_msg AS (
           INSERT INTO messages (chat_id, sender_user_id, body, content_type, reply_to_message_id)
           VALUES ($1, $2, $3, 'text', $4)
           RETURNING *
         )
         SELECT m.*, u.address AS sender_address
           FROM new_msg m
           JOIN users u ON u.id = m.sender_user_id`,
        [id, callerId, body, reply_to_message_id ?? null]
      );

      // Fire reply/@-mention notifications out-of-band; never fail the send on it.
      // DM → restrict targets to the chat's participants.
      const participantIds = others.rows.map((r) => r.user_id);
      try {
        const notified = await notifyReplyAndMentions({
          pool,
          chatId: id,
          messageId: inserted.rows[0].id,
          senderUserId: callerId,
          senderAddress: inserted.rows[0].sender_address,
          body,
          replyToMessageId: reply_to_message_id ?? null,
          replyParentAuthorId: replyContext?.parentAuthorId ?? null,
          accessibleUserIds: participantIds,
        });
        broadcastNotificationBump(notified);
      } catch (notifyError) {
        fastify.log.error({ notifyError }, 'Error creating chat notifications (DM send)');
      }

      // Trigger fires pg_notify; ChatNotifier handles fan-out.
      // reactions: [] keeps the shape consistent with GET /:id/messages.
      const message = { ...inserted.rows[0], reactions: [], reply_to: replyContext?.replyTo ?? null };
      return reply.status(201).send(ok({ message }));
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
        `UPDATE messages SET deleted_at = NOW(), deleted_by = $3
          WHERE id = $1 AND chat_id = $2 AND sender_user_id = $3 AND deleted_at IS NULL
          RETURNING id`,
        [messageId, id, callerId]
      );
      if (result.rows.length === 0) {
        // Either not found, not in chat, not the sender, or already deleted.
        return sendError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found or not deletable');
      }

      // Self-delete → deleted_by_admin: false. The global room has no
      // chat_participants rows, so it must fan out to global subscribers
      // instead of the (empty) participant set.
      if (id === GLOBAL_CHAT_ID) {
        broadcastGlobalChatDeletedEvent({ messageId, deletedByAdmin: false });
      } else {
        const participantIds = await getChatParticipantUserIds(pool, id);
        broadcastChatDeletedEvent({
          chatId: id,
          messageId,
          participantUserIds: participantIds,
          deletedByAdmin: false,
        });
      }

      return reply.send(ok({ chat_id: id, message_id: messageId, deleted: true }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error deleting message');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to delete message');
    }
  });

  /**
   * PATCH /api/v1/chats/:id/messages/:messageId
   * Edit caller's own message. Serves DMs and the global room (id = global UUID);
   * branches the broadcast on GLOBAL_CHAT_ID, same as delete. Edits are allowed
   * any time; `edited_at` is stamped so clients can show an "(edited)" tag.
   * Cannot edit a soft-deleted message.
   */
  fastify.patch('/:id/messages/:messageId', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (request, reply) => {
    try {
      const { id, messageId } = ChatMessageIdParamsSchema.parse(request.params);
      const { body } = SendMessageSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);

      // Same moderation boundary as sending: editing injects new content, so a
      // banned user must not be able to do it. Scope-aware (global-only vs
      // all-chats ban), mirroring the send + reaction routes.
      const banned = id === GLOBAL_CHAT_ID
        ? await callerIsBannedFromGlobalChat(pool, callerId)
        : await callerIsBannedFromChat(pool, callerId);
      if (banned) {
        return sendError(reply, 403, 'CHAT_BANNED', 'You are banned from messaging');
      }
      // Must still be able to see the chat (participant for DMs; anyone for the
      // global room) — an evicted DM member can't rewrite old messages.
      if (!(await canAccessChatMessages(id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      // Global room enforces its admin-configurable max length (may be < 4000).
      if (id === GLOBAL_CHAT_ID) {
        const config = await getGlobalChatConfig();
        if (body.length > config.max_message_length) {
          return sendError(
            reply,
            400,
            'MESSAGE_TOO_LONG',
            `Message exceeds the maximum length of ${config.max_message_length} characters`
          );
        }
      }

      // Ownership is enforced in the WHERE (sender_user_id = caller). The CTE
      // joins users so the broadcast/response carry sender_address, same as send.
      const result = await pool.query(
        `WITH upd AS (
           UPDATE messages SET body = $4, edited_at = NOW()
             WHERE id = $1 AND chat_id = $2 AND sender_user_id = $3 AND deleted_at IS NULL
             RETURNING *
         )
         SELECT m.*, u.address AS sender_address
           FROM upd m
           JOIN users u ON u.id = m.sender_user_id`,
        [messageId, id, callerId, body]
      );
      if (result.rows.length === 0) {
        // Not found, not in chat, not the sender, or already deleted.
        return sendError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found or not editable');
      }

      // Keep the public message shape consistent with the read paths: expose
      // deleted_by_admin, not the raw deleter id. (Both null here — not deleted.)
      const { deleted_by, deleted_reason, ...row } = result.rows[0];
      void deleted_by;
      void deleted_reason;
      const message = { ...row, deleted_by_admin: false, reactions: [] };

      if (id === GLOBAL_CHAT_ID) {
        broadcastGlobalChatEditedEvent({ message });
      } else {
        const participantIds = await getChatParticipantUserIds(pool, id);
        broadcastChatEditedEvent({ message, participantUserIds: participantIds });
      }

      return reply.send(ok({ message }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error editing message');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to edit message');
    }
  });

  /** Participant of the chat, or anyone for the global room. */
  async function canAccessChatMessages(chatId: string, userId: number): Promise<boolean> {
    if (chatId === GLOBAL_CHAT_ID) return true;
    return userIsParticipant(pool, chatId, userId);
  }

  /** Absolute per-emoji count after an add/remove, for idempotent client patching. */
  async function getReactionCount(messageId: string, emoji: string): Promise<number> {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM message_reactions WHERE message_id = $1 AND emoji = $2`,
      [messageId, emoji]
    );
    return r.rows[0]?.c ?? 0;
  }

  /**
   * GET /api/v1/chats/:id/messages/:messageId/reactions
   * Who reacted, grouped by emoji (each with the reactor addresses, oldest
   * first). Public for the global room; participants only for DMs.
   */
  fastify.get('/:id/messages/:messageId/reactions', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      const { id, messageId } = ChatMessageIdParamsSchema.parse(request.params);
      const callerId = request.user ? parseInt(request.user.sub, 10) : null;

      // Global room is publicly readable; DMs require a participant.
      if (id !== GLOBAL_CHAT_ID) {
        if (callerId === null) {
          return sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required');
        }
        if (!(await canAccessChatMessages(id, callerId))) {
          return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
        }
      }

      const msg = await pool.query(
        `SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2`,
        [messageId, id]
      );
      if (msg.rows.length === 0) {
        return sendError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
      }

      const result = await pool.query(
        `SELECT mr.emoji,
                COUNT(*)::int AS count,
                json_agg(json_build_object('address', u.address) ORDER BY mr.created_at) AS users
           FROM message_reactions mr
           JOIN users u ON u.id = mr.user_id
          WHERE mr.message_id = $1
          GROUP BY mr.emoji
          ORDER BY COUNT(*) DESC, mr.emoji`,
        [messageId]
      );

      return reply.send(ok({ message_id: messageId, reactions: result.rows }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error listing message reactions');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list reactions');
    }
  });

  /**
   * POST /api/v1/chats/:id/messages/:messageId/reactions
   * Add an emoji reaction. Idempotent: re-adding the same reaction is a no-op
   * (`added: false`) and does not broadcast. Works for DMs (participants only)
   * and the global room (any authenticated, non-banned user).
   */
  fastify.post('/:id/messages/:messageId/reactions', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
  }, async (request, reply) => {
    try {
      const { id, messageId } = ChatMessageIdParamsSchema.parse(request.params);
      const { emoji } = AddReactionSchema.parse(request.body);
      const callerId = parseInt(request.user!.sub, 10);

      // Scope-aware: a global-only ban silences reactions in the global room
      // but leaves DM reactions alone.
      const banned = id === GLOBAL_CHAT_ID
        ? await callerIsBannedFromGlobalChat(pool, callerId)
        : await callerIsBannedFromChat(pool, callerId);
      if (banned) {
        return sendError(reply, 403, 'CHAT_BANNED', 'You are banned from messaging');
      }
      if (!(await canAccessChatMessages(id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      const msg = await pool.query(
        `SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL`,
        [messageId, id]
      );
      if (msg.rows.length === 0) {
        return sendError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
      }

      const inserted = await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING
         RETURNING 1`,
        [messageId, callerId, emoji]
      );
      const added = inserted.rows.length > 0;

      if (added) {
        const count = await getReactionCount(messageId, emoji);
        broadcastChatReactionEvent({
          chatId: id,
          messageId,
          userId: callerId,
          address: request.user!.address,
          emoji,
          count,
          action: 'added',
          audience: id === GLOBAL_CHAT_ID ? 'global' : await getChatParticipantUserIds(pool, id),
        });
      }

      return reply.send(ok({ chat_id: id, message_id: messageId, emoji, added }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error adding reaction');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to add reaction');
    }
  });

  /**
   * DELETE /api/v1/chats/:id/messages/:messageId/reactions/:emoji
   * Remove the caller's reaction. :emoji is URL-encoded.
   */
  fastify.delete('/:id/messages/:messageId/reactions/:emoji', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    try {
      const params = ReactionParamsSchema.parse(request.params);
      const emoji = EmojiSchema.parse(decodeURIComponent(params.emoji));
      const callerId = parseInt(request.user!.sub, 10);

      if (!(await canAccessChatMessages(params.id, callerId))) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found');
      }

      const deleted = await pool.query(
        `DELETE FROM message_reactions mr
          USING messages m
          WHERE mr.message_id = m.id
            AND m.chat_id = $1
            AND mr.message_id = $2
            AND mr.user_id = $3
            AND mr.emoji = $4
          RETURNING 1`,
        [params.id, params.messageId, callerId, emoji]
      );
      if (deleted.rows.length === 0) {
        return sendError(reply, 404, 'REACTION_NOT_FOUND', 'Reaction not found');
      }

      const count = await getReactionCount(params.messageId, emoji);
      broadcastChatReactionEvent({
        chatId: params.id,
        messageId: params.messageId,
        userId: callerId,
        address: request.user!.address,
        emoji,
        count,
        action: 'removed',
        audience:
          params.id === GLOBAL_CHAT_ID ? 'global' : await getChatParticipantUserIds(pool, params.id),
      });

      return reply.send(ok({
        chat_id: params.id,
        message_id: params.messageId,
        emoji,
        removed: true,
      }));
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
      }
      fastify.log.error({ error }, 'Error removing reaction');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to remove reaction');
    }
  });
}

