import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalize } from 'viem/ens';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { generateSimilarNames, OPENAI_MODEL_NAME } from '../services/openai';

/** Cache TTL: 60 days in milliseconds */
const CACHE_TTL_DAYS = 60;

const AiRecommendationsParamsSchema = z.object({
  name: z.string().min(1).max(40),
});

export async function aiRecommendationsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /ai-recommendations/:name
   *
   * Returns AI-generated similar name suggestions for an ENS label.
   * Checks DB cache first; on miss, looks up the name's clubs for context,
   * calls OpenAI inline, and caches the result.
   *
   * Response: { success: true, data: { suggestions: string[] } }
   */
  fastify.get('/:name', async (request, reply) => {
    const params = AiRecommendationsParamsSchema.parse(request.params);

    // Strip .eth suffix, then ENS-normalize to canonical form
    let baseName: string;
    try {
      const stripped = params.name.replace(/\.eth$/i, '').trim();
      baseName = normalize(stripped);
    } catch {
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
        const suggestions = cached.rows[0].recommendations as string[];
        const response: APIResponse = {
          success: true,
          data: { suggestions },
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
        return reply.header('X-Cache', 'HIT').send(response);
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
      console.error(`[ai-recommendations] Error for "${baseName}":`, error);
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
      return reply.status(500).send(response);
    }
  });
}
