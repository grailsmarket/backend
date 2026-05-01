import { getPostgresPool } from '../../../shared/src';
import { fetchBalances } from './balances';
import { getRedisClient } from '../utils/redis';

const QUOTA_CACHE_TTL_SECONDS = 300;

export interface CommentConfig {
  warning_threshold: number;
  suspension_threshold: number;
  suspension_window_days: number;
  default_suspension_days: number;
  quota_cap: number;
  quota_floor: number;
  quota_names_weight: number;
  quota_listings_weight: number;
  quota_eth_weight: number;
  max_comment_length: number;
}

export interface QuotaSnapshot {
  used: number;
  max: number;
  remaining: number;
  resetsAt: string;
}

export async function getCommentConfig(): Promise<CommentConfig> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT warning_threshold, suspension_threshold, suspension_window_days,
            default_suspension_days, quota_cap, quota_floor,
            quota_names_weight, quota_listings_weight, quota_eth_weight,
            max_comment_length
       FROM comment_config WHERE id = 1`
  );
  if (result.rows.length === 0) {
    // Defensive default if the seed row is missing
    return {
      warning_threshold: 3,
      suspension_threshold: 5,
      suspension_window_days: 30,
      default_suspension_days: 7,
      quota_cap: 50,
      quota_floor: 1,
      quota_names_weight: 1,
      quota_listings_weight: 2,
      quota_eth_weight: 5,
      max_comment_length: 500,
    };
  }
  const row = result.rows[0];
  return {
    warning_threshold: Number(row.warning_threshold),
    suspension_threshold: Number(row.suspension_threshold),
    suspension_window_days: Number(row.suspension_window_days),
    default_suspension_days: Number(row.default_suspension_days),
    quota_cap: Number(row.quota_cap),
    quota_floor: Number(row.quota_floor),
    quota_names_weight: Number(row.quota_names_weight),
    quota_listings_weight: Number(row.quota_listings_weight),
    quota_eth_weight: Number(row.quota_eth_weight),
    max_comment_length: Number(row.max_comment_length),
  };
}

async function computeQuotaCap(
  address: string,
  config: CommentConfig
): Promise<number> {
  const pool = getPostgresPool();
  const lower = address.toLowerCase();

  // Cap names contribution at 20 per the user's spec — diminishing returns
  // past that point would make the formula too generous to large holders.
  const namesResult = await pool.query(
    `SELECT LEAST(COUNT(*), 20)::int AS c FROM ens_names WHERE LOWER(owner_address) = $1`,
    [lower]
  );
  const names = namesResult.rows[0]?.c ?? 0;

  const listingsResult = await pool.query(
    `SELECT COUNT(*)::int AS c FROM listings
      WHERE LOWER(seller_address) = $1 AND status = 'active'`,
    [lower]
  );
  const listings = listingsResult.rows[0]?.c ?? 0;

  // Sum ETH + WETH wei → ETH float for the formula. Failures here (RPC down,
  // unknown address) fall back to 0, which means the user still gets the
  // quota_floor — never a hard 0 just because RPC blipped.
  let ethEquivalent = 0;
  try {
    const balances = await fetchBalances(address);
    const ethWei = BigInt(balances.eth.wei);
    const wethWei = BigInt(balances.weth.wei);
    const totalWei = ethWei + wethWei;
    // Convert to ETH as a float; safe because the eth_weight coefficient is
    // small and the cap clamps the result.
    ethEquivalent = Number(totalWei) / 1e18;
  } catch {
    ethEquivalent = 0;
  }

  const raw =
    names * config.quota_names_weight +
    listings * config.quota_listings_weight +
    ethEquivalent * config.quota_eth_weight;

  const clamped = Math.max(
    config.quota_floor,
    Math.min(config.quota_cap, Math.floor(raw))
  );
  return clamped;
}

export async function getQuotaCap(
  address: string,
  config: CommentConfig
): Promise<number> {
  const redis = getRedisClient();
  const key = `comments:quota:${address.toLowerCase()}`;

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        const n = parseInt(cached, 10);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      // fall through to compute
    }
  }

  const cap = await computeQuotaCap(address, config);

  if (redis) {
    try {
      await redis.setex(key, QUOTA_CACHE_TTL_SECONDS, String(cap));
    } catch {
      // cache write failures are non-fatal
    }
  }

  return cap;
}

export async function getQuotaUsed(userId: number): Promise<number> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS c FROM comments
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  return result.rows[0]?.c ?? 0;
}

export async function getQuotaSnapshot(
  userId: number,
  address: string
): Promise<QuotaSnapshot> {
  const config = await getCommentConfig();
  const [max, used] = await Promise.all([
    getQuotaCap(address, config),
    getQuotaUsed(userId),
  ]);

  // Rolling 24h: "resets" is when the user's oldest in-window comment ages out
  // (or 24h from now if there are none). The frontend uses this to render a
  // countdown; it is a lower bound on when the next slot frees up.
  const pool = getPostgresPool();
  const oldestResult = await pool.query(
    `SELECT MIN(created_at) AS oldest FROM comments
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  let resetsAt: Date;
  const oldest = oldestResult.rows[0]?.oldest as Date | null;
  if (oldest) {
    resetsAt = new Date(oldest.getTime() + 24 * 60 * 60 * 1000);
  } else {
    resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  return {
    used,
    max,
    remaining: Math.max(0, max - used),
    resetsAt: resetsAt.toISOString(),
  };
}
