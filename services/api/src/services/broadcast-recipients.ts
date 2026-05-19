import { getPostgresPool } from '../../../shared/src';

export interface BroadcastRecipient {
  userId: number;
  email: string | null;
  emailVerified: boolean;
}

/**
 * All users eligible for an admin broadcast. No tier filtering —
 * admin broadcasts address every registered user. Per-channel reachability
 * (e.g. verified email) is decided downstream by the caller.
 */
export async function getAllBroadcastRecipients(): Promise<BroadcastRecipient[]> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT id AS user_id, email, email_verified FROM users`
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailVerified: r.email_verified,
  }));
}

export async function getUnverifiedEmailRecipients(): Promise<BroadcastRecipient[]> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT id AS user_id, email, email_verified
     FROM users
     WHERE email IS NOT NULL AND email_verified = FALSE`
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailVerified: r.email_verified,
  }));
}

export async function getRecipientsByAddresses(
  addresses: string[]
): Promise<BroadcastRecipient[]> {
  if (addresses.length === 0) return [];
  const lowered = addresses.map((a) => a.toLowerCase());
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT id AS user_id, email, email_verified
     FROM users
     WHERE LOWER(address) = ANY($1::text[])`,
    [lowered]
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailVerified: r.email_verified,
  }));
}
