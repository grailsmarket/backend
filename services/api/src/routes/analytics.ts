import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, CURRENCY_ADDRESSES } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

const TimeRangeSchema = z.object({
  period: z.enum(['24h', '7d', '30d', '90d', 'all']).default('7d'),
});

const ClubAnalyticsQuerySchema = z.object({
  club: z.string().min(1),
  period: z.enum(['24h', '7d', '30d', '90d']).default('7d'),
});

export async function analyticsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /analytics/market
   * Get global market statistics
   */
  fastify.get('/market', async (request, reply) => {
    const query = TimeRangeSchema.parse(request.query);

    // Convert period to interval
    const periodMap: Record<string, string> = {
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days',
      '90d': '90 days',
      'all': '100 years', // Effectively no limit
    };
    const interval = periodMap[query.period];

    const [statsResult, volumeResult, activityResult] = await Promise.all([
      // Overall statistics
      pool.query(
        `SELECT
          COUNT(DISTINCT en.id) as total_names,
          COUNT(DISTINCT l.id) as active_listings,
          COUNT(DISTINCT o.id) as active_offers,
          COUNT(DISTINCT w.user_id) as total_watchers,
          SUM(en.view_count) as total_views
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
        LEFT JOIN offers o ON o.ens_name_id = en.id AND o.status IN ('pending', 'active')
        LEFT JOIN watchlist w ON w.ens_name_id = en.id`
      ),

      // Volume statistics for period
      pool.query(
        `SELECT
          COUNT(*) as sales_count,
          SUM(sale_price_wei::numeric) as total_volume_wei,
          AVG(sale_price_wei::numeric) as avg_sale_price_wei,
          MAX(sale_price_wei::numeric) as max_sale_price_wei,
          MIN(sale_price_wei::numeric) as min_sale_price_wei,
          COUNT(DISTINCT ens_name_id) as unique_names_sold,
          COUNT(DISTINCT buyer_address) as unique_buyers,
          COUNT(DISTINCT seller_address) as unique_sellers
        FROM sales
        WHERE sale_date > NOW() - INTERVAL '${interval}'
          AND (currency_address = $1 OR currency_address = $2)`,
        [CURRENCY_ADDRESSES.ETH, CURRENCY_ADDRESSES.WETH]
      ),

      // Activity statistics for period
      pool.query(
        `SELECT
          (SELECT COUNT(*) FROM name_views WHERE viewed_at > NOW() - INTERVAL '${interval}') as views_count,
          (SELECT COUNT(*) FROM watchlist WHERE added_at > NOW() - INTERVAL '${interval}') as watchlist_adds_count,
          (SELECT COUNT(*) FROM name_votes WHERE created_at > NOW() - INTERVAL '${interval}') as votes_count,
          (SELECT COUNT(*) FROM offers WHERE created_at > NOW() - INTERVAL '${interval}') as offers_count,
          (SELECT COUNT(*) FROM listings WHERE created_at > NOW() - INTERVAL '${interval}') as listings_count`
      ),
    ]);

    const stats = statsResult.rows[0];
    const volume = volumeResult.rows[0];
    const activity = activityResult.rows[0];

    const response: APIResponse = {
      success: true,
      data: {
        period: query.period,
        overview: {
          total_names: parseInt(stats.total_names || '0'),
          active_listings: parseInt(stats.active_listings || '0'),
          active_offers: parseInt(stats.active_offers || '0'),
          total_watchers: parseInt(stats.total_watchers || '0'),
          total_views: parseInt(stats.total_views || '0'),
        },
        volume: {
          sales_count: parseInt(volume.sales_count || '0'),
          total_volume_wei: volume.total_volume_wei || '0',
          avg_sale_price_wei: volume.avg_sale_price_wei || '0',
          max_sale_price_wei: volume.max_sale_price_wei || '0',
          min_sale_price_wei: volume.min_sale_price_wei || '0',
          unique_names_sold: parseInt(volume.unique_names_sold || '0'),
          unique_buyers: parseInt(volume.unique_buyers || '0'),
          unique_sellers: parseInt(volume.unique_sellers || '0'),
        },
        activity: {
          views: parseInt(activity.views_count || '0'),
          watchlist_adds: parseInt(activity.watchlist_adds_count || '0'),
          votes: parseInt(activity.votes_count || '0'),
          offers: parseInt(activity.offers_count || '0'),
          listings: parseInt(activity.listings_count || '0'),
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /analytics/clubs/:club
   * Get analytics for a specific club
   */
  fastify.get('/clubs/:club', async (request, reply) => {
    const { club } = request.params as { club: string };
    const query = TimeRangeSchema.parse(request.query);

    const periodMap: Record<string, string> = {
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days',
      '90d': '90 days',
      'all': '100 years',
    };
    const interval = periodMap[query.period];

    const [statsResult, volumeResult, activityResult, floorResult] = await Promise.all([
      // Club statistics
      pool.query(
        `SELECT
          COUNT(DISTINCT en.id) as member_count,
          COUNT(DISTINCT l.id) as active_listings,
          COUNT(DISTINCT o.id) as active_offers,
          SUM(en.view_count) as total_views
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
        LEFT JOIN offers o ON o.ens_name_id = en.id AND o.status IN ('pending', 'active')
        WHERE $1 = ANY(en.clubs)`,
        [club]
      ),

      // Volume for club
      pool.query(
        `SELECT
          COUNT(*) as sales_count,
          SUM(s.sale_price_wei::numeric) as total_volume_wei,
          AVG(s.sale_price_wei::numeric) as avg_sale_price_wei
        FROM sales s
        JOIN ens_names en ON s.ens_name_id = en.id
        WHERE $1 = ANY(en.clubs)
          AND s.sale_date > NOW() - INTERVAL '${interval}'
          AND (s.currency_address = $2 OR s.currency_address = $3)`,
        [club, CURRENCY_ADDRESSES.ETH, CURRENCY_ADDRESSES.WETH]
      ),

      // Activity for club
      pool.query(
        `SELECT
          (SELECT COUNT(*) FROM name_views nv
           JOIN ens_names en ON nv.ens_name_id = en.id
           WHERE $1 = ANY(en.clubs) AND nv.viewed_at > NOW() - INTERVAL '${interval}') as views_count,
          (SELECT COUNT(*) FROM watchlist w
           JOIN ens_names en ON w.ens_name_id = en.id
           WHERE $1 = ANY(en.clubs) AND w.added_at > NOW() - INTERVAL '${interval}') as watchlist_adds,
          (SELECT COUNT(*) FROM name_votes nv
           JOIN ens_names en ON nv.ens_name_id = en.id
           WHERE $1 = ANY(en.clubs) AND nv.created_at > NOW() - INTERVAL '${interval}') as votes_count`,
        [club]
      ),

      // Current floor price
      pool.query(
        `SELECT MIN(l.price_wei::numeric) as floor_price_wei
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE l.status = 'active'
          AND $1 = ANY(en.clubs)
          AND (l.currency_address = $2 OR l.currency_address = $3)`,
        [club, CURRENCY_ADDRESSES.ETH, CURRENCY_ADDRESSES.WETH]
      ),
    ]);

    const stats = statsResult.rows[0];
    const volume = volumeResult.rows[0];
    const activity = activityResult.rows[0];
    const floor = floorResult.rows[0];

    const response: APIResponse = {
      success: true,
      data: {
        club,
        period: query.period,
        stats: {
          member_count: parseInt(stats.member_count || '0'),
          active_listings: parseInt(stats.active_listings || '0'),
          active_offers: parseInt(stats.active_offers || '0'),
          total_views: parseInt(stats.total_views || '0'),
          floor_price_wei: floor.floor_price_wei || null,
        },
        volume: {
          sales_count: parseInt(volume.sales_count || '0'),
          total_volume_wei: volume.total_volume_wei || '0',
          avg_sale_price_wei: volume.avg_sale_price_wei || '0',
        },
        activity: {
          views: parseInt(activity.views_count || '0'),
          watchlist_adds: parseInt(activity.watchlist_adds || '0'),
          votes: parseInt(activity.votes_count || '0'),
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /analytics/price-trends
   * Get price trends over time (daily aggregates)
   */
  fastify.get('/price-trends', async (request, reply) => {
    const query = TimeRangeSchema.parse(request.query);

    const periodMap: Record<string, string> = {
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days',
      '90d': '90 days',
      'all': '100 years',
    };
    const interval = periodMap[query.period];

    const result = await pool.query(
      `SELECT
        DATE_TRUNC('day', sale_date) as date,
        COUNT(*) as sales_count,
        SUM(sale_price_wei::numeric) as volume_wei,
        AVG(sale_price_wei::numeric) as avg_price_wei,
        MAX(sale_price_wei::numeric) as max_price_wei,
        MIN(sale_price_wei::numeric) as min_price_wei
      FROM sales
      WHERE sale_date > NOW() - INTERVAL '${interval}'
        AND (currency_address = $1 OR currency_address = $2)
      GROUP BY DATE_TRUNC('day', sale_date)
      ORDER BY date ASC`,
      [CURRENCY_ADDRESSES.ETH, CURRENCY_ADDRESSES.WETH]
    );

    const response: APIResponse = {
      success: true,
      data: {
        period: query.period,
        trends: result.rows.map(row => ({
          date: row.date,
          sales_count: parseInt(row.sales_count),
          volume_wei: row.volume_wei,
          avg_price_wei: row.avg_price_wei,
          max_price_wei: row.max_price_wei,
          min_price_wei: row.min_price_wei,
        })),
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /analytics/volume
   * Get volume distribution by price ranges
   */
  fastify.get('/volume', async (request, reply) => {
    const query = TimeRangeSchema.parse(request.query);

    const periodMap: Record<string, string> = {
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days',
      '90d': '90 days',
      'all': '100 years',
    };
    const interval = periodMap[query.period];

    // Price ranges in wei (for ETH: 0.01, 0.1, 0.5, 1, 5, 10, 50, 100+)
    const result = await pool.query(
      `SELECT
        CASE
          WHEN sale_price_wei::numeric < 10000000000000000 THEN '< 0.01 ETH'
          WHEN sale_price_wei::numeric < 100000000000000000 THEN '0.01-0.1 ETH'
          WHEN sale_price_wei::numeric < 500000000000000000 THEN '0.1-0.5 ETH'
          WHEN sale_price_wei::numeric < 1000000000000000000 THEN '0.5-1 ETH'
          WHEN sale_price_wei::numeric < 5000000000000000000 THEN '1-5 ETH'
          WHEN sale_price_wei::numeric < 10000000000000000000 THEN '5-10 ETH'
          WHEN sale_price_wei::numeric < 50000000000000000000 THEN '10-50 ETH'
          ELSE '50+ ETH'
        END as price_range,
        COUNT(*) as sales_count,
        SUM(sale_price_wei::numeric) as total_volume_wei
      FROM sales
      WHERE sale_date > NOW() - INTERVAL '${interval}'
        AND (currency_address = $1 OR currency_address = $2)
      GROUP BY price_range
      ORDER BY MIN(sale_price_wei::numeric) ASC`,
      [CURRENCY_ADDRESSES.ETH, CURRENCY_ADDRESSES.WETH]
    );

    const response: APIResponse = {
      success: true,
      data: {
        period: query.period,
        distribution: result.rows.map(row => ({
          price_range: row.price_range,
          sales_count: parseInt(row.sales_count),
          total_volume_wei: row.total_volume_wei,
        })),
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });

  /**
   * GET /analytics/user/me
   * Get personal analytics for authenticated user
   */
  fastify.get('/user/me', { preHandler: requireAuth }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const userIdStr = userId.toString();

    const [activityResult, collectionsResult] = await Promise.all([
      // User activity statistics
      pool.query(
        `SELECT
          (SELECT COUNT(*) FROM name_views WHERE viewer_identifier = $1 AND viewer_type = 'authenticated') as names_viewed,
          (SELECT COUNT(*) FROM watchlist WHERE user_id = $2) as names_watching,
          (SELECT COUNT(*) FROM name_votes WHERE user_id = $2) as votes_cast,
          (SELECT COUNT(*) FROM offers WHERE buyer_address = (SELECT address FROM users WHERE id = $2)) as offers_made,
          (SELECT COUNT(*) FROM sales WHERE buyer_address = (SELECT address FROM users WHERE id = $2)) as names_purchased,
          (SELECT COUNT(*) FROM sales WHERE seller_address = (SELECT address FROM users WHERE id = $2)) as names_sold`,
        [userIdStr, userId]
      ),

      // User's collection value (owned names with listings/offers)
      pool.query(
        `SELECT
          COUNT(*) as owned_names_count,
          COUNT(DISTINCT l.id) as listed_names_count,
          SUM(CASE WHEN l.id IS NOT NULL THEN l.price_wei::numeric ELSE 0 END) as total_listing_value_wei,
          SUM(COALESCE(en.highest_offer_wei::numeric, 0)) as total_offer_value_wei
        FROM ens_names en
        LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
        WHERE LOWER(en.owner_address) = LOWER((SELECT address FROM users WHERE id = $1))`,
        [userId]
      ),
    ]);

    const activity = activityResult.rows[0];
    const collections = collectionsResult.rows[0];

    const response: APIResponse = {
      success: true,
      data: {
        activity: {
          names_viewed: parseInt(activity.names_viewed || '0'),
          names_watching: parseInt(activity.names_watching || '0'),
          votes_cast: parseInt(activity.votes_cast || '0'),
          offers_made: parseInt(activity.offers_made || '0'),
          names_purchased: parseInt(activity.names_purchased || '0'),
          names_sold: parseInt(activity.names_sold || '0'),
        },
        portfolio: {
          owned_names_count: parseInt(collections.owned_names_count || '0'),
          listed_names_count: parseInt(collections.listed_names_count || '0'),
          total_listing_value_wei: collections.total_listing_value_wei || '0',
          total_offer_value_wei: collections.total_offer_value_wei || '0',
        },
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}
