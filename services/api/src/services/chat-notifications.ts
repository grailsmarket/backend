import { getPostgresPool } from '../../../shared/src';

type Pool = ReturnType<typeof getPostgresPool>;

export type ChatNotificationType = 'chat_reply' | 'chat_mention';

/**
 * Matches an @-mention of either an ENS name (`@vitalik.eth`, subdomains allowed)
 * or a raw address (`@0x…40hex`). Mirrors the shape used by the frontend
 * linkifyMessage regex so the parsed set matches what the composer inserts.
 */
const MENTION_RE = /@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth|0x[a-fA-F0-9]{40})/gi;

/** Cap mention notifications per message so a single post can't fan out unbounded. */
const MAX_MENTION_NOTIFICATIONS = 10;
const SNIPPET_LEN = 140;

const snippet = (body: string): string => {
  const t = body.trim();
  return t.length > SNIPPET_LEN ? t.slice(0, SNIPPET_LEN) : t;
};

export interface ChatNotificationRow {
  userId: number;
  type: ChatNotificationType;
  metadata: Record<string, unknown>;
}

/**
 * Bulk INSERT chat notifications in a single round-trip (ens_name_id = NULL).
 * Generalizes the insertChatModNotification pattern; chat notifications are
 * delivered in-app (bell), not via the email/send-notification queue.
 */
export async function insertChatNotifications(pool: Pool, rows: ChatNotificationRow[]): Promise<void> {
  if (rows.length === 0) return;
  await pool.query(
    `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
     SELECT u, t, NULL, m::jsonb, NOW()
       FROM unnest($1::int[], $2::text[], $3::text[]) AS x(u, t, m)`,
    [rows.map((r) => r.userId), rows.map((r) => r.type), rows.map((r) => JSON.stringify(r.metadata))]
  );
}

/**
 * Compact preview of a parent message, embedded on a reply. `body` is null once
 * the parent is soft-deleted (the read paths null it out); non-null at send-time.
 */
export interface ReplyPreview {
  id: string;
  sender_address: string;
  body: string | null;
  deleted: boolean;
}

/**
 * Shared `reply_to` preview pieces, used by both message read paths and the WS
 * broadcast query so the shape (and truncation length) stay in one place.
 * REPLY_TO_PREVIEW_SELECT is a column expression aliased `reply_to`; it requires
 * REPLY_TO_JOINS (aliases `p` = parent message, `pu` = parent author) in FROM.
 */
export const REPLY_TO_PREVIEW_SELECT = `
                CASE WHEN m.reply_to_message_id IS NOT NULL THEN
                  json_build_object(
                    'id', m.reply_to_message_id,
                    'sender_address', pu.address,
                    'body', CASE WHEN p.deleted_at IS NOT NULL THEN NULL ELSE LEFT(p.body, ${SNIPPET_LEN}) END,
                    'deleted', (p.deleted_at IS NOT NULL)
                  )
                ELSE NULL END AS reply_to`;

export const REPLY_TO_JOINS = `
           LEFT JOIN messages p  ON p.id = m.reply_to_message_id
           LEFT JOIN users    pu ON pu.id = p.sender_user_id`;

/**
 * Validate that a reply target exists, belongs to the same chat, and isn't
 * deleted. Returns the parent's author id + a ready preview, or null when the
 * target is invalid (caller should respond 400). Body is truncated to the
 * preview length to keep payloads small.
 */
export async function validateReplyTarget(
  pool: Pool,
  chatId: string,
  replyToMessageId: string
): Promise<{ parentAuthorId: number; replyTo: ReplyPreview } | null> {
  const r = await pool.query(
    `SELECT m.sender_user_id, m.body, u.address AS sender_address
       FROM messages m
       JOIN users u ON u.id = m.sender_user_id
      WHERE m.id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL`,
    [replyToMessageId, chatId]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    parentAuthorId: row.sender_user_id,
    replyTo: {
      id: replyToMessageId,
      sender_address: row.sender_address,
      body: snippet(row.body),
      deleted: false,
    },
  };
}

/** Unique, lowercased @-mention tokens (ENS names + addresses) found in a body. */
export function parseMentionTokens(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

/**
 * Resolve mention tokens to EXISTING users (token -> users.id). ENS names go
 * through ens_names.owner_address; raw addresses match users.address directly.
 * Never creates stub users (unlike resolveRecipientToUserId) — we only notify
 * real accounts.
 */
export async function resolveMentionUserIds(pool: Pool, tokens: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (tokens.length === 0) return result;

  const addresses = tokens.filter((t) => /^0x[a-f0-9]{40}$/.test(t));
  const ensNames = tokens.filter((t) => !t.startsWith('0x'));

  if (ensNames.length > 0) {
    const r = await pool.query(
      `SELECT LOWER(en.name) AS token, u.id AS user_id
         FROM ens_names en
         JOIN users u ON u.address = LOWER(en.owner_address)
        WHERE LOWER(en.name) = ANY($1::text[]) AND en.owner_address IS NOT NULL`,
      [ensNames]
    );
    for (const row of r.rows) result.set(row.token, row.user_id);
  }

  if (addresses.length > 0) {
    const r = await pool.query(
      `SELECT LOWER(address) AS token, id AS user_id FROM users WHERE LOWER(address) = ANY($1::text[])`,
      [addresses]
    );
    for (const row of r.rows) result.set(row.token, row.user_id);
  }

  return result;
}

export interface NotifyReplyAndMentionsArgs {
  pool: Pool;
  chatId: string;
  messageId: string;
  senderUserId: number;
  senderAddress: string;
  body: string;
  /** The parent message id when this is a reply, or null. */
  replyToMessageId?: string | null;
  /** Author of the (already validated, non-deleted, same-chat) parent, or null when not a reply. */
  replyParentAuthorId?: number | null;
  /**
   * Restrict notification targets to chat members. For DMs pass the participant
   * user ids; for the global room pass null (any resolved user may be notified).
   */
  accessibleUserIds: number[] | null;
}

/**
 * Create the reply notification (to the parent's author) and @-mention
 * notifications (to resolved, accessible users) for a freshly-sent message.
 * Skips the sender, de-dupes mention against the reply target, and caps mention
 * fan-out. Returns the distinct user ids notified (for the WS unread bump).
 */
export async function notifyReplyAndMentions(args: NotifyReplyAndMentionsArgs): Promise<number[]> {
  const { pool, chatId, messageId, senderUserId, senderAddress, body, replyParentAuthorId, accessibleUserIds } = args;
  const notified = new Set<number>();
  const rows: ChatNotificationRow[] = [];
  const snip = snippet(body);

  const canNotify = (userId: number): boolean => {
    if (userId === senderUserId) return false; // never notify yourself
    if (accessibleUserIds && !accessibleUserIds.includes(userId)) return false; // DM: members only
    return true;
  };

  // Reply → parent author. (Notification metadata uses camelCase to match the
  // frontend NotificationMetadata convention, e.g. priceWei/offerAmountWei.)
  if (replyParentAuthorId != null && canNotify(replyParentAuthorId)) {
    rows.push({
      userId: replyParentAuthorId,
      type: 'chat_reply',
      metadata: { chatId, messageId, replyToMessageId: args.replyToMessageId ?? null, senderAddress, snippet: snip },
    });
    notified.add(replyParentAuthorId);
  }

  // @-mentions → resolved users (excluding anyone already notified above), capped.
  const tokens = parseMentionTokens(body);
  if (tokens.length > 0) {
    const resolved = await resolveMentionUserIds(pool, tokens);
    let count = 0;
    for (const userId of resolved.values()) {
      if (count >= MAX_MENTION_NOTIFICATIONS) break;
      if (notified.has(userId) || !canNotify(userId)) continue;
      rows.push({ userId, type: 'chat_mention', metadata: { chatId, messageId, senderAddress, snippet: snip } });
      notified.add(userId);
      count++;
    }
  }

  // One round-trip for the reply + all mention notifications.
  await insertChatNotifications(pool, rows);
  return [...notified];
}
