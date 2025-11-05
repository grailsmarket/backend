import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { buildSearchResults } from '../utils/response-builder';
import { requireAuth, optionalAuth } from '../middleware/auth';

const RecommendationQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(50).default(10),
});

const AlsoViewedQuerySchema = z.object({
  name: z.string().min(1),
  limit: z.coerce.number().min(1).max(50).default(10),
});

export async function recommendationsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /recommendations/also-viewed
   * Get names that collectors who viewed this name also viewed
   * (Collaborative filtering based on view patterns)
   */
  fastify.get('/also-viewed', { preHandler: optionalAuth }, async (request, reply) => {
    const query = AlsoViewedQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    // First, get the ens_name_id for the target name
    const nameResult = await pool.query(
      'SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)',
      [query.name]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'NAME_NOT_FOUND',
          message: `ENS name "${query.name}" not found`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const targetNameId = nameResult.rows[0].id;

    // Use the helper function to get also-viewed names
    const result = await pool.query(
      'SELECT * FROM get_collectors_also_viewed($1, $2)',
      [targetNameId, query.limit]
    );

    if (result.rows.length === 0) {
      return reply.send({
        success: true,
        data: {
          names: [],
          meta: {
            type: 'also-viewed',
            target_name: query.name,
            limit: query.limit,
          }
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add recommendation metrics
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        recommendation_metrics: {
          type: 'also-viewed',
          also_viewed_count: parseInt(metrics?.also_viewed_count || '0'),
          shared_viewers_count: metrics?.shared_viewers?.length || 0,
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          type: 'also-viewed',
          target_name: query.name,
          limit: query.limit,
        }
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /recommendations/similar-to-watchlist
   * Get names watched by users with similar watchlists
   * (Requires authentication)
   */
  fastify.get('/similar-to-watchlist', { preHandler: requireAuth }, async (request, reply) => {
    const query = RecommendationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);

    // Use the helper function to get similar names
    const result = await pool.query(
      'SELECT * FROM get_similar_to_watchlist($1, $2)',
      [userId, query.limit]
    );

    if (result.rows.length === 0) {
      return reply.send({
        success: true,
        data: {
          names: [],
          meta: {
            type: 'similar-to-watchlist',
            limit: query.limit,
          }
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add recommendation metrics
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        recommendation_metrics: {
          type: 'similar-to-watchlist',
          similarity_score: parseInt(metrics?.similarity_score || '0'),
          common_watchers: parseInt(metrics?.common_watchers || '0'),
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          type: 'similar-to-watchlist',
          limit: query.limit,
        }
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /recommendations/based-on-votes
   * Get names upvoted by users with similar voting patterns
   * (Requires authentication)
   */
  fastify.get('/based-on-votes', { preHandler: requireAuth }, async (request, reply) => {
    const query = RecommendationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);

    // Use the helper function to get recommendations
    const result = await pool.query(
      'SELECT * FROM get_recommendations_by_votes($1, $2)',
      [userId, query.limit]
    );

    if (result.rows.length === 0) {
      return reply.send({
        success: true,
        data: {
          names: [],
          meta: {
            type: 'based-on-votes',
            limit: query.limit,
          }
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add recommendation metrics
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        recommendation_metrics: {
          type: 'based-on-votes',
          recommendation_score: parseInt(metrics?.recommendation_score || '0'),
          similar_voters: parseInt(metrics?.similar_voters || '0'),
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          type: 'based-on-votes',
          limit: query.limit,
        }
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /recommendations/for-you
   * Get personalized recommendations combining all signals
   * (Requires authentication)
   */
  fastify.get('/for-you', { preHandler: requireAuth }, async (request, reply) => {
    const query = RecommendationQuerySchema.parse(request.query);
    const userId = parseInt(request.user!.sub);

    // Get recommendations from all three sources
    const [watchlistRecs, voteRecs] = await Promise.all([
      pool.query('SELECT * FROM get_similar_to_watchlist($1, $2)', [userId, 20]),
      pool.query('SELECT * FROM get_recommendations_by_votes($1, $2)', [userId, 20]),
    ]);

    // Combine and score recommendations
    const combinedScores = new Map<number, { name: string; score: number }>();

    // Add watchlist recommendations (weight: 3x)
    watchlistRecs.rows.forEach(row => {
      const score = parseInt(row.similarity_score) * 3;
      combinedScores.set(row.ens_name_id, {
        name: row.name,
        score: score
      });
    });

    // Add vote recommendations (weight: 2x)
    voteRecs.rows.forEach(row => {
      const score = parseInt(row.recommendation_score) * 2;
      const existing = combinedScores.get(row.ens_name_id);
      if (existing) {
        existing.score += score;
      } else {
        combinedScores.set(row.ens_name_id, {
          name: row.name,
          score: score
        });
      }
    });

    // Sort by combined score and take top results
    const sortedRecs = Array.from(combinedScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit);

    if (sortedRecs.length === 0) {
      return reply.send({
        success: true,
        data: {
          names: [],
          meta: {
            type: 'for-you',
            limit: query.limit,
          }
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      });
    }

    // Enrich with full name data
    const names = sortedRecs.map(rec => rec.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add recommendation metrics
    const resultsWithMetrics = enrichedResults.map(name => {
      const rec = sortedRecs.find(r => r.name === name.name);
      return {
        ...name,
        recommendation_metrics: {
          type: 'for-you',
          personalized_score: rec?.score || 0,
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          type: 'for-you',
          limit: query.limit,
          score_weights: {
            watchlist_similarity: 3,
            vote_similarity: 2,
          }
        }
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}
