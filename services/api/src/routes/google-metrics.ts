import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, normalizeEnsName } from '../../../shared/src';
import { fetchKeywordMetrics } from '../services/google-ads';
import { cacheHandler } from '../middleware/cache';
import { optionalAuth } from '../middleware/auth';
import { generateCacheKey, setCachedResponse } from '../utils/redis';

/** Cache TTL in days */
const CACHE_TTL_DAYS = 30;
/** Short TTL for negative (name-not-found) cache entries */
const NEGATIVE_CACHE_TTL_SECONDS = 300;

const GoogleMetricsParamsSchema = z.object({
  name: z.string().min(1).max(40),
});

export async function googleMetricsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /google-metrics/:name
   *
   * Returns Google Ads keyword metrics for an ENS label.
   * Cached results are public. Fetching fresh results requires auth.
   * Rate limited to 60 req/min per IP.
   *
   * Response: { success: true, data: { avgMonthlySearches, avgCpc, monthlyTrend, relatedKeywordCount, competition } }
   */
  fastify.get('/:name', {
    preHandler: [optionalAuth, cacheHandler],
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const params = GoogleMetricsParamsSchema.parse(request.params);

    // Strip .eth suffix, then ENS-normalize to canonical form
    const stripped = params.name.replace(/\.eth$/i, '').trim();
    const normalizedResult = normalizeEnsName(stripped);
    const baseName = normalizedResult.normalized;

    if (!baseName) {
      const response: APIResponse = {
        success: false,
        error: {
          code: 'INVALID_NAME',
          message: 'Invalid ENS name',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
      return reply.status(400).send(response);
    }

    if (baseName.length > 20) {
      const response: APIResponse = {
        success: false,
        error: {
          code: 'INVALID_NAME',
          message: 'Name must be 20 characters or fewer',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
      return reply.status(400).send(response);
    }

    try {
      // Check DB cache first
      const cached = await pool.query(
        `SELECT metrics FROM google_metrics
         WHERE name = $1 AND expires_at > NOW()`,
        [baseName],
      );

      if (cached.rows.length > 0) {
        const response: APIResponse = {
          success: true,
          data: cached.rows[0].metrics,
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.header('X-Cache', 'HIT').send(response);
      }

      // Cache miss: only authenticated users can trigger a fresh fetch
      if (!request.user) {
        request.log.debug({ name: baseName }, 'Google metrics cache miss, auth required');
        const response: APIResponse = {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Log in to view Google metrics',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.status(401).send(response);
      }

      // Cache miss — name must exist in ens_names to prevent abuse
      const nameRow = await pool.query(
        `SELECT 1 FROM ens_names WHERE name = $1`,
        [`${baseName}.eth`],
      );

      if (nameRow.rows.length === 0) {
        const response: APIResponse = {
          success: true,
          data: null,
          meta: {
            timestamp: new Date().toISOString(),
          },
        };

        // Cache negative result briefly to reduce repeated DB lookups for unknown names
        const cacheKey = generateCacheKey(request.url, request.query as Record<string, unknown>);
        await setCachedResponse(cacheKey, response, NEGATIVE_CACHE_TTL_SECONDS);

        return reply.send(response);
      }

      // Fetch from Google Ads API
      const metrics = await fetchKeywordMetrics(baseName);

      if (!metrics) {
        // API failed or not configured — return empty (don't cache failures)
        const response: APIResponse = {
          success: true,
          data: null,
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.header('X-Cache', 'MISS').send(response);
      }

      // UPSERT to DB cache
      const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO google_metrics (name, metrics, expires_at, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (name)
         DO UPDATE SET
           metrics = EXCLUDED.metrics,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [baseName, JSON.stringify(metrics), expiresAt],
      );

      const response: APIResponse = {
        success: true,
        data: metrics,
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
      return reply.header('X-Cache', 'MISS').send(response);
    } catch (error) {
      const response: APIResponse = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch Google metrics',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
      request.log.error({ err: error, name: baseName }, 'Google metrics failed');
      return reply.status(500).send(response);
    }
  });
}
