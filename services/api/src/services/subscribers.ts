import { getPostgresPool } from '../../../shared/src';

export interface SubscriberRow {
  userId: number;
  email: string | null;
  emailVerified: boolean;
  telegramConnected: boolean;
  telegramChatId: string | null;
}

/**
 * Active paid subscribers with tier_id >= minTierId (and not expired).
 * Pulls denormalized fields from users, joined to active user_subscriptions.
 */
export async function getActiveSubscribers(minTierId: number): Promise<SubscriberRow[]> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT DISTINCT u.id AS user_id,
            u.email, u.email_verified,
            u.telegram_connected, u.telegram_chat_id
     FROM user_subscriptions us
     JOIN users u ON us.user_id = u.id
     WHERE us.status = 'active'
       AND us.tier_id >= $1
       AND (us.expires_at IS NULL OR us.expires_at > NOW())`,
    [minTierId]
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailVerified: r.email_verified,
    telegramConnected: r.telegram_connected,
    telegramChatId: r.telegram_chat_id,
  }));
}
