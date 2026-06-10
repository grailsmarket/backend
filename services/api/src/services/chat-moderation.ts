import { getPostgresPool } from '../../../shared/src';

/**
 * A chat_user_status ban blocks DM sends, chat creation, reactions, AND
 * global chat sends. Shared by chats.ts and chats-global.ts so the ban
 * semantics can't drift between the two send paths.
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
