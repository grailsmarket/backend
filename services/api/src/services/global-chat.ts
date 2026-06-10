import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../../../shared/src';
import { getRedisClient } from '../utils/redis';

// The single well-known global chat room, seeded by migration 0880. It has no
// chat_participants rows; routes and WS fan-out branch on this UUID.
export const GLOBAL_CHAT_ID = '00000000-0000-0000-0000-000000000001';

const TIER_CACHE_TTL_SECONDS = 300;
const CONFIG_CACHE_TTL_SECONDS = 30;
const CONFIG_CACHE_KEY = 'globalchat:config';

export type GlobalChatTier = 'avatar' | 'name' | 'none';

export interface GlobalChatConfig {
  enabled: boolean;
  quota_with_avatar: number | null; // null = unlimited
  quota_with_name: number;
  quota_without_name: number;
  max_message_length: number;
}

export interface GlobalQuotaSnapshot {
  tier: GlobalChatTier;
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null;
  resets_at: string;
}

export async function getGlobalChatConfig(): Promise<GlobalChatConfig> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get(CONFIG_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as GlobalChatConfig;
      }
    } catch {
      // fall through to the DB
    }
  }

  const config = await fetchGlobalChatConfig();

  if (redis) {
    try {
      await redis.setex(CONFIG_CACHE_KEY, CONFIG_CACHE_TTL_SECONDS, JSON.stringify(config));
    } catch {
      // cache write failures are non-fatal
    }
  }

  return config;
}

/**
 * Drop the cached config so admin PATCHes take effect immediately instead of
 * after the cache TTL.
 */
export async function invalidateGlobalChatConfigCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(CONFIG_CACHE_KEY);
  } catch {
    // worst case the stale config lives for the remaining TTL
  }
}

async function fetchGlobalChatConfig(): Promise<GlobalChatConfig> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT enabled, quota_with_avatar, quota_with_name, quota_without_name,
            max_message_length
       FROM global_chat_config WHERE id = 1`
  );
  if (result.rows.length === 0) {
    // Defensive default if the seed row is missing
    return {
      enabled: true,
      quota_with_avatar: null,
      quota_with_name: 20,
      quota_without_name: 1,
      max_message_length: 1000,
    };
  }
  const row = result.rows[0];
  return {
    enabled: Boolean(row.enabled),
    quota_with_avatar:
      row.quota_with_avatar === null ? null : Number(row.quota_with_avatar),
    quota_with_name: Number(row.quota_with_name),
    quota_without_name: Number(row.quota_without_name),
    max_message_length: Number(row.max_message_length),
  };
}

async function computeUserTier(address: string): Promise<GlobalChatTier> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE COALESCE(metadata->>'avatar', '') <> '')::int AS with_avatar
       FROM ens_names
      WHERE LOWER(owner_address) = $1`,
    [address.toLowerCase()]
  );
  const total = result.rows[0]?.total ?? 0;
  const withAvatar = result.rows[0]?.with_avatar ?? 0;
  if (withAvatar > 0) return 'avatar';
  if (total > 0) return 'name';
  return 'none';
}

export async function getUserTier(address: string): Promise<GlobalChatTier> {
  const redis = getRedisClient();
  const key = `globalchat:tier:${address.toLowerCase()}`;

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached === 'avatar' || cached === 'name' || cached === 'none') {
        return cached;
      }
    } catch {
      // fall through to compute
    }
  }

  const tier = await computeUserTier(address);

  if (redis) {
    try {
      await redis.setex(key, TIER_CACHE_TTL_SECONDS, tier);
    } catch {
      // cache write failures are non-fatal
    }
  }

  return tier;
}

export function tierLimit(
  tier: GlobalChatTier,
  config: GlobalChatConfig
): number | null {
  switch (tier) {
    case 'avatar':
      return config.quota_with_avatar;
    case 'name':
      return config.quota_with_name;
    case 'none':
      return config.quota_without_name;
  }
}

/**
 * Accepts an optional PoolClient so the send path can run the count inside
 * the same advisory-locked transaction as the INSERT (see chats-global.ts).
 */
export async function getQuotaUsedToday(
  userId: number,
  db?: Pool | PoolClient
): Promise<number> {
  const executor = db ?? getPostgresPool();
  // Soft-deleted messages still count: deleting your own message doesn't
  // refund quota. created_at is assumed UTC (same as the rest of the schema).
  const result = await executor.query(
    `SELECT COUNT(*)::int AS c FROM messages
      WHERE chat_id = $1 AND sender_user_id = $2
        AND created_at >= date_trunc('day', NOW())`,
    [GLOBAL_CHAT_ID, userId]
  );
  return result.rows[0]?.c ?? 0;
}

export function nextUtcMidnight(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();
}

export async function getGlobalQuotaSnapshot(
  userId: number,
  address: string,
  config?: GlobalChatConfig
): Promise<GlobalQuotaSnapshot> {
  const cfg = config ?? (await getGlobalChatConfig());
  const tier = await getUserTier(address);
  const limit = tierLimit(tier, cfg);

  if (limit === null) {
    return {
      tier,
      used: 0,
      limit: null,
      remaining: null,
      resets_at: nextUtcMidnight(),
    };
  }

  const used = await getQuotaUsedToday(userId);
  return {
    tier,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resets_at: nextUtcMidnight(),
  };
}
