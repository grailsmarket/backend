import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { buildSearchResults } from '../utils/response-builder';
import { optionalAuth } from '../middleware/auth';

const TrendingQuerySchema = z.object({
  period: z.enum(['24h', '7d']).default('24h'),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export async function trendingRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /trending/views
   * Get trending names by view count
   */
  fastify.get('/views', { preHandler: optionalAuth }, async (request, reply) => {
    const query = TrendingQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    const viewName = query.period === '24h' ? 'trending_views_24h' : 'trending_views_7d';

    const result = await pool.query(
      `SELECT
        id,
        name,
        token_id,
        ${query.period === '24h' ? 'view_count_24h' : 'view_count_7d'} as period_views,
        ${query.period === '24h' ? 'unique_viewers_24h' : 'unique_viewers_7d'} as unique_viewers,
        total_views
      FROM ${viewName}
      LIMIT $1`,
      [query.limit]
    );

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add trending metrics to enriched results
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        trending_metrics: {
          period: query.period,
          period_views: metrics?.period_views || 0,
          unique_viewers: metrics?.unique_viewers || 0,
          total_views: metrics?.total_views || 0,
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          period: query.period,
          type: 'views',
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
   * GET /trending/watchlist
   * Get trending names by watchlist additions
   */
  fastify.get('/watchlist', { preHandler: optionalAuth }, async (request, reply) => {
    const query = TrendingQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    const viewName = query.period === '24h' ? 'trending_watchlist_24h' : 'trending_watchlist_7d';

    const result = await pool.query(
      `SELECT
        id,
        name,
        token_id,
        ${query.period === '24h' ? 'watchlist_count_24h' : 'watchlist_count_7d'} as period_additions,
        total_watchers
      FROM ${viewName}
      LIMIT $1`,
      [query.limit]
    );

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add trending metrics to enriched results
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        trending_metrics: {
          period: query.period,
          period_additions: metrics?.period_additions || 0,
          total_watchers: metrics?.total_watchers || 0,
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          period: query.period,
          type: 'watchlist',
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
   * GET /trending/votes
   * Get trending names by voting activity
   */
  fastify.get('/votes', { preHandler: optionalAuth }, async (request, reply) => {
    const query = TrendingQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    const viewName = query.period === '24h' ? 'trending_votes_24h' : 'trending_votes_7d';

    const result = await pool.query(
      `SELECT
        id,
        name,
        token_id,
        ${query.period === '24h' ? 'upvotes_24h' : 'upvotes_7d'} as period_upvotes,
        ${query.period === '24h' ? 'downvotes_24h' : 'downvotes_7d'} as period_downvotes,
        ${query.period === '24h' ? 'total_votes_24h' : 'total_votes_7d'} as period_votes,
        net_score_total
      FROM ${viewName}
      LIMIT $1`,
      [query.limit]
    );

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add trending metrics to enriched results
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        trending_metrics: {
          period: query.period,
          period_upvotes: metrics?.period_upvotes || 0,
          period_downvotes: metrics?.period_downvotes || 0,
          period_votes: metrics?.period_votes || 0,
          net_score_total: metrics?.net_score_total || 0,
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          period: query.period,
          type: 'votes',
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
   * GET /trending/sales
   * Get trending names by sales activity
   */
  fastify.get('/sales', { preHandler: optionalAuth }, async (request, reply) => {
    const query = TrendingQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    const viewName = query.period === '24h' ? 'trending_sales_24h' : 'trending_sales_7d';

    const result = await pool.query(
      `SELECT
        id,
        name,
        token_id,
        ${query.period === '24h' ? 'sales_count_24h' : 'sales_count_7d'} as period_sales,
        ${query.period === '24h' ? 'total_volume_24h' : 'total_volume_7d'} as period_volume,
        ${query.period === '24h' ? 'avg_price_24h' : 'avg_price_7d'} as avg_price,
        ${query.period === '24h' ? 'max_price_24h' : 'max_price_7d'} as max_price,
        ${query.period === '24h' ? 'min_price_24h' : 'min_price_7d'} as min_price
      FROM ${viewName}
      LIMIT $1`,
      [query.limit]
    );

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add trending metrics to enriched results
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        trending_metrics: {
          period: query.period,
          period_sales: metrics?.period_sales || 0,
          period_volume: metrics?.period_volume || '0',
          avg_price: metrics?.avg_price || '0',
          max_price: metrics?.max_price || '0',
          min_price: metrics?.min_price || '0',
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          period: query.period,
          type: 'sales',
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
   * GET /trending/offers
   * Get trending names by offer activity
   */
  fastify.get('/offers', { preHandler: optionalAuth }, async (request, reply) => {
    const query = TrendingQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    const viewName = query.period === '24h' ? 'trending_offers_24h' : 'trending_offers_7d';

    const result = await pool.query(
      `SELECT
        id,
        name,
        token_id,
        ${query.period === '24h' ? 'offers_count_24h' : 'offers_count_7d'} as period_offers,
        ${query.period === '24h' ? 'highest_offer_24h' : 'highest_offer_7d'} as highest_offer,
        ${query.period === '24h' ? 'avg_offer_24h' : 'avg_offer_7d'} as avg_offer,
        ${query.period === '24h' ? 'unique_bidders_24h' : 'unique_bidders_7d'} as unique_bidders
      FROM ${viewName}
      LIMIT $1`,
      [query.limit]
    );

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add trending metrics to enriched results
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        trending_metrics: {
          period: query.period,
          period_offers: metrics?.period_offers || 0,
          highest_offer: metrics?.highest_offer || '0',
          avg_offer: metrics?.avg_offer || '0',
          unique_bidders: metrics?.unique_bidders || 0,
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          period: query.period,
          type: 'offers',
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
   * GET /trending/composite
   * Get trending names by composite score (all signals combined)
   */
  fastify.get('/composite', { preHandler: optionalAuth }, async (request, reply) => {
    const query = TrendingQuerySchema.parse(request.query);
    const userId = request.user ? parseInt(request.user.sub) : undefined;

    const viewName = query.period === '24h' ? 'trending_composite_24h' : 'trending_composite_7d';

    const result = await pool.query(
      `SELECT
        id,
        name,
        token_id,
        trending_score,
        ${query.period === '24h' ? 'views_24h' : 'views_7d'} as period_views,
        ${query.period === '24h' ? 'watchlist_adds_24h' : 'watchlist_adds_7d'} as period_watchlist_adds,
        ${query.period === '24h' ? 'votes_24h' : 'votes_7d'} as period_votes,
        ${query.period === '24h' ? 'offers_24h' : 'offers_7d'} as period_offers,
        ${query.period === '24h' ? 'sales_24h' : 'sales_7d'} as period_sales
      FROM ${viewName}
      LIMIT $1`,
      [query.limit]
    );

    // Enrich with full name data
    const names = result.rows.map(row => row.name);
    const enrichedResults = await buildSearchResults(names, userId);

    // Add trending metrics to enriched results
    const resultsWithMetrics = enrichedResults.map(name => {
      const metrics = result.rows.find(r => r.name === name.name);
      return {
        ...name,
        trending_metrics: {
          period: query.period,
          trending_score: parseFloat(metrics?.trending_score || '0'),
          breakdown: {
            views: metrics?.period_views || 0,
            watchlist_adds: metrics?.period_watchlist_adds || 0,
            votes: metrics?.period_votes || 0,
            offers: metrics?.period_offers || 0,
            sales: metrics?.period_sales || 0,
          }
        }
      };
    });

    const response: APIResponse = {
      success: true,
      data: {
        names: resultsWithMetrics,
        meta: {
          period: query.period,
          type: 'composite',
          limit: query.limit,
          score_weights: {
            views: 1,
            watchlist_adds: 5,
            upvotes: 3,
            downvotes: -1,
            offers: 10,
            listings: 8,
            sales: 50,
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
