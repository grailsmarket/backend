import Redis from 'ioredis';
import { config } from '../../../shared/src';

let redisClient: Redis | null = null;

/**
 * Get or create Redis client
 */
export function getRedisClient(): Redis | null {
  if (!config.redis.enabled) {
    return null;
  }

  if (!redisClient) {
    try {
      redisClient = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        lazyConnect: true,
      });

      redisClient.on('error', (error) => {
        console.error('Redis client error:', error);
      });

      redisClient.on('connect', () => {
        console.log('Redis client connected');
      });

      redisClient.on('ready', () => {
        console.log('Redis client ready');
      });

      // Connect immediately
      redisClient.connect().catch((error) => {
        console.error('Failed to connect to Redis:', error);
        redisClient = null;
      });
    } catch (error) {
      console.error('Failed to create Redis client:', error);
      redisClient = null;
    }
  }

  return redisClient;
}

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Generate cache key from request
 */
export function generateCacheKey(url: string, queryParams?: Record<string, any>): string {
  const baseKey = `cache:${url}`;

  if (!queryParams || Object.keys(queryParams).length === 0) {
    return baseKey;
  }

  // Sort keys for consistent cache keys
  const sortedParams = Object.keys(queryParams)
    .sort()
    .map(key => `${key}=${JSON.stringify(queryParams[key])}`)
    .join('&');

  return `${baseKey}?${sortedParams}`;
}

/**
 * Get cached response
 */
export async function getCachedResponse(key: string): Promise<any | null> {
  const redis = getRedisClient();
  if (!redis) {
    return null;
  }

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error('Redis get error:', error);
  }

  return null;
}

/**
 * Set cached response
 */
export async function setCachedResponse(
  key: string,
  value: any,
  ttlSeconds: number = config.redis.cacheTtlSeconds
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (error) {
    console.error('Redis set error:', error);
  }
}

/**
 * Invalidate cache by pattern
 */
export async function invalidateCache(pattern: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) {
    return 0;
  }

  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      return await redis.del(...keys);
    }
    return 0;
  } catch (error) {
    console.error('Redis invalidate error:', error);
    return 0;
  }
}

/**
 * Clear all cache
 */
export async function clearAllCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }

  try {
    const keys = await redis.keys('cache:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    console.error('Redis clear all error:', error);
  }
}
