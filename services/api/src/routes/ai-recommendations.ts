import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, normalizeEnsName } from '../../../shared/src';
import { generateSimilarNames, OPENAI_MODEL_NAME } from '../services/openai';
import { cacheHandler } from '../middleware/cache';
import { optionalAuth } from '../middleware/auth';
import { generateCacheKey, setCachedResponse } from '../utils/redis';

/** Cache TTL in days */
const CACHE_TTL_DAYS = 60;
/** Short TTL for negative (name-not-found) cache entries */
const NEGATIVE_CACHE_TTL_SECONDS = 300;

const AiRecommendationsParamsSchema = z.object({
  name: z.string().min(1).max(40),
});

export async function aiRecommendationsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /ai-recommendations/:name
   *
   * Returns AI-generated similar name suggestions for an ENS label.
   * Cached results are public. Generating fresh results requires auth.
   * Rate limited to 60 req/min per IP.
   * Checks DB cache first; on miss, looks up the name's clubs for context,
   * calls OpenAI inline, and caches the result.
   *
   * Response: { success: true, data: { suggestions: string[] } }
   */
  fastify.get('/:name', {
    preHandler: [optionalAuth, cacheHandler],
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const params = AiRecommendationsParamsSchema.parse(request.params);

    // Strip .eth suffix, then ENS-normalize to canonical form via shared helper
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

    if (!baseName || baseName.length < 3) {
      const response: APIResponse = {
        success: false,
        error: {
          code: 'INVALID_NAME',
          message: 'Name must be at least 3 characters',
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
        `SELECT recommendations FROM ai_recommendations
         WHERE name = $1 AND expires_at > NOW()`,
        [baseName]
      );

      if (cached.rows.length > 0) {
        // Two-tier cache behavior:
        // - Redis layer (cacheHandler): 15s
        // - Postgres layer (ai_recommendations): 60 days
        const raw = cached.rows[0].recommendations;
        const suggestions = Array.isArray(raw) && raw.every((s) => typeof s === 'string')
          ? raw
          : [];
        const response: APIResponse = {
          success: true,
          data: { suggestions },
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.header('X-Cache', 'HIT').send(response);
      }

      // Cache miss: only authenticated users can generate new recommendations
      if (!request.user) {
        request.log.debug({ name: baseName }, 'AI recommendations cache miss, auth required');
        const response: APIResponse = {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Log in to generate new AI recommendations',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.status(401).send(response);
      }

      // Cache miss — name must exist in ens_names to prevent abuse
      const nameRow = await pool.query(
        `SELECT COALESCE(clubs, ARRAY[]::text[]) AS clubs
         FROM ens_names WHERE name = $1`,
        [`${baseName}.eth`]
      );

      if (nameRow.rows.length === 0) {
        // Name not in DB — return empty, don't call OpenAI
        const response: APIResponse = {
          success: true,
          data: { suggestions: [] },
          meta: {
            timestamp: new Date().toISOString(),
          },
        };

        // Cache negative result briefly to reduce repeated DB lookups for unknown names.
        const cacheKey = generateCacheKey(request.url, request.query as Record<string, unknown>);
        await setCachedResponse(cacheKey, response, NEGATIVE_CACHE_TTL_SECONDS);

        return reply.send(response);
      }

      const categories: string[] = nameRow.rows[0].clubs;

      // Call OpenAI inline
      const suggestions = await generateSimilarNames(baseName, categories);

      if (!suggestions || suggestions.length === 0) {
        // OpenAI failed or returned nothing — return empty (don't cache failures)
        const response: APIResponse = {
          success: true,
          data: { suggestions: [] },
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.header('X-Cache', 'MISS').send(response);
      }

      // UPSERT to DB cache
      const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO ai_recommendations (name, recommendations, model, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (name)
         DO UPDATE SET
           recommendations = EXCLUDED.recommendations,
           model = EXCLUDED.model,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [baseName, JSON.stringify(suggestions), OPENAI_MODEL_NAME, expiresAt]
      );

      const response: APIResponse = {
        success: true,
        data: { suggestions },
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
          message: 'Failed to fetch AI recommendations',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      };
      request.log.error({ err: error, name: baseName }, 'AI recommendations failed');
      return reply.status(500).send(response);
    }
  });
}
