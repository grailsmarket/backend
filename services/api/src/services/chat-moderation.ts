import { getPostgresPool } from '../../../shared/src';

/**
 * All-chats ban (chat_user_status.status): blocks DM sends, chat creation,
 * DM reactions, AND global chat. Shared by chats.ts and chats-global.ts so
 * the ban semantics can't drift between the send paths.
 */
export async function callerIsBannedFromChat(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM chat_user_status WHERE user_id = $1 AND status = 'banned' LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

/**
 * Global chat participation check: an all-chats ban OR a global-only ban
 * (chat_user_status.global_status) silences the user in the global room —
 * no messages, no reactions. Reading stays public; DMs are unaffected by a
 * global-only ban.
 */
export async function callerIsBannedFromGlobalChat(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM chat_user_status
      WHERE user_id = $1 AND (status = 'banned' OR global_status = 'banned')
      LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}
