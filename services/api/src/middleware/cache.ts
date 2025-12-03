import { FastifyRequest, FastifyReply } from 'fastify';
import { generateCacheKey, getCachedResponse, setCachedResponse } from '../utils/redis';
import { config } from '../../../shared/src';

export interface CacheOptions {
  ttl?: number; // TTL in seconds (default: from config)
  skipCache?: (request: FastifyRequest) => boolean; // Function to determine if cache should be skipped
  keyGenerator?: (request: FastifyRequest) => string; // Custom cache key generator
}

/**
 * Cache middleware for Fastify routes
 *
 * Usage in routes:
 * ```
 * fastify.get('/endpoint', { preHandler: withCache() }, async (request, reply) => {
 *   // Your handler code
 * });
 *
 * // With custom options
 * fastify.get('/endpoint', {
 *   preHandler: withCache({ ttl: 30, skipCache: (req) => req.query.nocache === 'true' })
 * }, async (request, reply) => {
 *   // Your handler code
 * });
 * ```
 */
export function withCache(options: CacheOptions = {}) {
  const {
    ttl = config.redis.cacheTtlSeconds,
    skipCache = () => false,
    keyGenerator,
  } = options;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip cache if Redis is disabled
    if (!config.redis.enabled) {
      return;
    }

    // Skip cache if custom skip function returns true
    if (skipCache(request)) {
      return;
    }

    // Skip cache if Authorization header is present (authenticated request)
    if (request.headers.authorization) {
      return;
    }

    // Generate cache key
    const cacheKey = keyGenerator
      ? keyGenerator(request)
      : generateCacheKey(request.url, request.query as Record<string, any>);

    // Try to get cached response
    const cached = await getCachedResponse(cacheKey);

    if (cached) {
      // Send cached response
      reply
        .header('X-Cache', 'HIT')
        .header('Content-Type', 'application/json')
        .send(cached);
      return;
    }

    // Store original send function
    const originalSend = reply.send.bind(reply);

    // Override send to cache the response
    reply.send = function (payload: any) {
      // Only cache successful responses (2xx status codes)
      if (reply.statusCode >= 200 && reply.statusCode < 300) {
        // Cache the response asynchronously (don't wait)
        setCachedResponse(cacheKey, payload, ttl).catch((error) => {
          request.log.error('Failed to cache response:', error);
        });
      }

      // Set cache header
      reply.header('X-Cache', 'MISS');

      // Call original send
      return originalSend(payload);
    };
  };
}

/**
 * Create a route-specific cache wrapper with custom options
 *
 * Usage:
 * ```
 * const cacheForListings = createCacheHandler({ ttl: 30 });
 * fastify.get('/listings', { preHandler: cacheForListings }, handler);
 * ```
 */
export function createCacheHandler(options: CacheOptions) {
  return withCache(options);
}

/**
 * Default cache handler with 15 second TTL
 */
export const cacheHandler = withCache();

/**
 * Cache handler for longer-lived data (1 minute)
 */
export const longCacheHandler = withCache({ ttl: 60 });

/**
 * Cache handler for very stable data (5 minutes)
 */
export const veryLongCacheHandler = withCache({ ttl: 300 });
