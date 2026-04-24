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

/**
 * Users currently on one of the given paid tiers with an unexpired subscription.
 * tierIds are contract tier IDs (1=plus, 2=pro, 3=gold).
 */
export async function getRecipientsByTiers(
  tierIds: number[]
): Promise<BroadcastRecipient[]> {
  if (tierIds.length === 0) return [];
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT id AS user_id, email, email_verified
     FROM users
     WHERE tier_id = ANY($1::int[])
       AND (tier_expires_at IS NULL OR tier_expires_at > NOW())`,
    [tierIds]
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailVerified: r.email_verified,
  }));
}

/**
 * Users not currently on an active paid tier — either never subscribed
 * (tier_id = 0) or their subscription has expired.
 */
export async function getUnsubscribedRecipients(): Promise<BroadcastRecipient[]> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT id AS user_id, email, email_verified
     FROM users
     WHERE tier_id = 0
        OR (tier_expires_at IS NOT NULL AND tier_expires_at <= NOW())`
  );
  return result.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    emailVerified: r.email_verified,
  }));
}
