import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse, CURRENCY_ADDRESSES } from '../../../shared/src';

const ChartQuerySchema = z.object({
  period: z.enum(['1d', '7d', '30d', '1y', 'all']).default('7d'),
  club: z.string().optional(),
});

type ChartQuery = z.infer<typeof ChartQuerySchema>;

interface TimeConfig {
  interval: string;
  truncUnit: 'hour' | 'day' | 'week' | 'month';
  seriesInterval: string;
}

function getTimeConfig(period: string): TimeConfig {
  if (period === '1d') {
    return { interval: '24 hours', truncUnit: 'hour', seriesInterval: '1 hour' };
  }
  if (period === '7d') {
    return { interval: '7 days', truncUnit: 'day', seriesInterval: '1 day' };
  }
  if (period === '30d') {
    return { interval: '30 days', truncUnit: 'day', seriesInterval: '1 day' };
  }
  if (period === '1y') {
    return { interval: '1 year', truncUnit: 'week', seriesInterval: '1 week' };
  }
  // 'all'
  return { interval: '8 years', truncUnit: 'month', seriesInterval: '1 month' };
}

/**
 * Parse club filter string into array, handling comma-separated values
 * Examples:
 *   "999" -> ["999"]
 *   "999,10k,prepunk" -> ["999", "10k", "prepunk"]
 *   undefined -> []
 */
function parseClubFilter(club: string | undefined): string[] {
  if (!club) return [];
  return club.split(',').map(c => c.trim()).filter(c => c);
}

function buildClubCondition(clubs: string[], paramNum: number): { condition: string; params: any[] } {
  if (clubs.length === 0) {
    return { condition: '', params: [] };
  }

  // Special values take precedence if included
  if (clubs.includes('any')) {
    return {
      condition: 'AND array_length(en.clubs, 1) > 0',
      params: [],
    };
  }

  if (clubs.includes('none')) {
    return {
      condition: 'AND (en.clubs IS NULL OR array_length(en.clubs, 1) = 0)',
      params: [],
    };
  }

  // Single club: use = ANY for exact match
  if (clubs.length === 1) {
    return {
      condition: `AND $${paramNum} = ANY(en.clubs)`,
      params: [clubs[0]],
    };
  }

  // Multiple clubs: use && for array overlap (matches any of the specified clubs)
  return {
    condition: `AND en.clubs && $${paramNum}::text[]`,
    params: [clubs],
  };
}

export async function chartsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /charts/sales
   * Get count of sales per time bucket with source breakdown
   */
  fastify.get('/sales', async (request, reply) => {
    const query = ChartQuerySchema.parse(request.query);
    const timeConfig = getTimeConfig(query.period);
    const clubs = parseClubFilter(query.club);
    const hasClubFilter = clubs.length > 0;
    const clubCondition = buildClubCondition(clubs, 1);

    const fromClause = hasClubFilter
      ? `FROM sales s
             JOIN ens_names en ON s.ens_name_id = en.id`
      : `FROM sales s`;

    try {
      const result = await pool.query(
        `WITH time_series AS (
          SELECT generate_series(
            DATE_TRUNC('${timeConfig.truncUnit}', NOW() - INTERVAL '${timeConfig.interval}'),
            DATE_TRUNC('${timeConfig.truncUnit}', NOW()),
            '${timeConfig.seriesInterval}'::interval
          ) AS date
        ),
        sales_data AS (
          SELECT
            DATE_TRUNC('${timeConfig.truncUnit}', s.sale_date) as date,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE s.source = 'grails') as grails,
            COUNT(*) FILTER (WHERE s.source = 'opensea') as opensea
          ${fromClause}
          WHERE s.sale_date > NOW() - INTERVAL '${timeConfig.interval}'
          ${hasClubFilter ? clubCondition.condition : ''}
          GROUP BY DATE_TRUNC('${timeConfig.truncUnit}', s.sale_date)
        )
        SELECT
          ts.date,
          COALESCE(sd.total, 0)::int as total,
          COALESCE(sd.grails, 0)::int as grails,
          COALESCE(sd.opensea, 0)::int as opensea
        FROM time_series ts
        LEFT JOIN sales_data sd ON ts.date = sd.date
        ORDER BY ts.date ASC`,
        clubCondition.params
      );

      const response: APIResponse = {
        success: true,
        data: {
          period: query.period,
          club: query.club || null,
          clubs: clubs.length > 0 ? clubs : null,
          points: result.rows.map(row => ({
            date: row.date.toISOString(),
            total: row.total,
            grails: row.grails,
            opensea: row.opensea,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch sales chart data',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /charts/volume
   * Get total sales volume per time bucket with source breakdown (ETH/WETH only)
   */
  fastify.get('/volume', async (request, reply) => {
    const query = ChartQuerySchema.parse(request.query);
    const timeConfig = getTimeConfig(query.period);
    const clubs = parseClubFilter(query.club);
    const hasClubFilter = clubs.length > 0;
    const clubCondition = buildClubCondition(clubs, 3);

    const fromClause = hasClubFilter
      ? `FROM sales s
             JOIN ens_names en ON s.ens_name_id = en.id`
      : `FROM sales s`;

    try {
      const result = await pool.query(
        `WITH time_series AS (
          SELECT generate_series(
            DATE_TRUNC('${timeConfig.truncUnit}', NOW() - INTERVAL '${timeConfig.interval}'),
            DATE_TRUNC('${timeConfig.truncUnit}', NOW()),
            '${timeConfig.seriesInterval}'::interval
          ) AS date
        ),
        volume_data AS (
          SELECT
            DATE_TRUNC('${timeConfig.truncUnit}', s.sale_date) as date,
            SUM(s.sale_price_wei::numeric) as total,
            COALESCE(SUM(s.sale_price_wei::numeric) FILTER (WHERE s.source = 'grails'), 0) as grails,
            COALESCE(SUM(s.sale_price_wei::numeric) FILTER (WHERE s.source = 'opensea'), 0) as opensea
          ${fromClause}
          WHERE s.sale_date > NOW() - INTERVAL '${timeConfig.interval}'
            AND (s.currency_address = $1 OR s.currency_address = $2)
          ${hasClubFilter ? clubCondition.condition : ''}
          GROUP BY DATE_TRUNC('${timeConfig.truncUnit}', s.sale_date)
        )
        SELECT
          ts.date,
          COALESCE(vd.total, 0)::text as total,
          COALESCE(vd.grails, 0)::text as grails,
          COALESCE(vd.opensea, 0)::text as opensea
        FROM time_series ts
        LEFT JOIN volume_data vd ON ts.date = vd.date
        ORDER BY ts.date ASC`,
        [CURRENCY_ADDRESSES.ETH, CURRENCY_ADDRESSES.WETH, ...clubCondition.params]
      );

      const response: APIResponse = {
        success: true,
        data: {
          period: query.period,
          club: query.club || null,
          clubs: clubs.length > 0 ? clubs : null,
          points: result.rows.map(row => ({
            date: row.date.toISOString(),
            total: row.total,
            grails: row.grails,
            opensea: row.opensea,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch volume chart data',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /charts/listings
   * Get count of listings created per time bucket with source breakdown
   */
  fastify.get('/listings', async (request, reply) => {
    const query = ChartQuerySchema.parse(request.query);
    const timeConfig = getTimeConfig(query.period);
    const clubs = parseClubFilter(query.club);
    const hasClubFilter = clubs.length > 0;
    const clubCondition = buildClubCondition(clubs, 1);

    const fromClause = hasClubFilter
      ? `FROM listings l
             JOIN ens_names en ON l.ens_name_id = en.id`
      : `FROM listings l`;

    try {
      const result = await pool.query(
        `WITH time_series AS (
          SELECT generate_series(
            DATE_TRUNC('${timeConfig.truncUnit}', NOW() - INTERVAL '${timeConfig.interval}'),
            DATE_TRUNC('${timeConfig.truncUnit}', NOW()),
            '${timeConfig.seriesInterval}'::interval
          ) AS date
        ),
        listings_data AS (
          SELECT
            DATE_TRUNC('${timeConfig.truncUnit}', l.created_at) as date,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE l.source = 'grails') as grails,
            COUNT(*) FILTER (WHERE l.source = 'opensea') as opensea
          ${fromClause}
          WHERE l.created_at > NOW() - INTERVAL '${timeConfig.interval}'
          ${hasClubFilter ? clubCondition.condition : ''}
          GROUP BY DATE_TRUNC('${timeConfig.truncUnit}', l.created_at)
        )
        SELECT
          ts.date,
          COALESCE(ld.total, 0)::int as total,
          COALESCE(ld.grails, 0)::int as grails,
          COALESCE(ld.opensea, 0)::int as opensea
        FROM time_series ts
        LEFT JOIN listings_data ld ON ts.date = ld.date
        ORDER BY ts.date ASC`,
        clubCondition.params
      );

      const response: APIResponse = {
        success: true,
        data: {
          period: query.period,
          club: query.club || null,
          clubs: clubs.length > 0 ? clubs : null,
          points: result.rows.map(row => ({
            date: row.date.toISOString(),
            total: row.total,
            grails: row.grails,
            opensea: row.opensea,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch listings chart data',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /charts/registrations
   * Get registration volume and cost over time
   */
  fastify.get('/registrations', async (request, reply) => {
    const query = ChartQuerySchema.parse(request.query);
    const timeConfig = getTimeConfig(query.period);
    const clubs = parseClubFilter(query.club);
    const hasClubFilter = clubs.length > 0;
    const clubCondition = buildClubCondition(clubs, 1);

    const fromClause = hasClubFilter
      ? `FROM registrations r
             JOIN ens_names en ON r.ens_name_id = en.id`
      : `FROM registrations r`;

    try {
      const result = await pool.query(
        `WITH time_series AS (
          SELECT generate_series(
            DATE_TRUNC('${timeConfig.truncUnit}', NOW() - INTERVAL '${timeConfig.interval}'),
            DATE_TRUNC('${timeConfig.truncUnit}', NOW()),
            '${timeConfig.seriesInterval}'::interval
          ) AS date
        ),
        registration_data AS (
          SELECT
            DATE_TRUNC('${timeConfig.truncUnit}', r.registration_date) as date,
            COUNT(*) as count,
            SUM(r.total_cost_wei::numeric) as total_cost_wei,
            AVG(r.total_cost_wei::numeric) as avg_cost_wei,
            SUM(r.base_cost_wei::numeric) as total_base_cost_wei,
            SUM(r.premium_wei::numeric) as total_premium_wei,
            COUNT(*) FILTER (WHERE r.premium_wei::numeric > 0) as premium_count
          ${fromClause}
          WHERE r.registration_date > NOW() - INTERVAL '${timeConfig.interval}'
          ${hasClubFilter ? clubCondition.condition : ''}
          GROUP BY DATE_TRUNC('${timeConfig.truncUnit}', r.registration_date)
        )
        SELECT
          ts.date,
          COALESCE(rd.count, 0)::int as count,
          COALESCE(rd.total_cost_wei, 0)::text as total_cost_wei,
          COALESCE(rd.avg_cost_wei, 0)::text as avg_cost_wei,
          COALESCE(rd.total_base_cost_wei, 0)::text as total_base_cost_wei,
          COALESCE(rd.total_premium_wei, 0)::text as total_premium_wei,
          COALESCE(rd.premium_count, 0)::int as premium_count
        FROM time_series ts
        LEFT JOIN registration_data rd ON ts.date = rd.date
        ORDER BY ts.date ASC`,
        clubCondition.params
      );

      const response: APIResponse = {
        success: true,
        data: {
          period: query.period,
          club: query.club || null,
          clubs: clubs.length > 0 ? clubs : null,
          points: result.rows.map(row => ({
            date: row.date.toISOString(),
            count: row.count,
            total_cost_wei: row.total_cost_wei,
            avg_cost_wei: row.avg_cost_wei,
            total_base_cost_wei: row.total_base_cost_wei,
            total_premium_wei: row.total_premium_wei,
            premium_count: row.premium_count,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch registrations chart data',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /charts/offers
   * Get count of offers created per time bucket with source breakdown
   */
  fastify.get('/offers', async (request, reply) => {
    const query = ChartQuerySchema.parse(request.query);
    const timeConfig = getTimeConfig(query.period);
    const clubs = parseClubFilter(query.club);
    const hasClubFilter = clubs.length > 0;
    const clubCondition = buildClubCondition(clubs, 1);

    const fromClause = hasClubFilter
      ? `FROM offers o
             JOIN ens_names en ON o.ens_name_id = en.id`
      : `FROM offers o`;

    try {
      const result = await pool.query(
        `WITH time_series AS (
          SELECT generate_series(
            DATE_TRUNC('${timeConfig.truncUnit}', NOW() - INTERVAL '${timeConfig.interval}'),
            DATE_TRUNC('${timeConfig.truncUnit}', NOW()),
            '${timeConfig.seriesInterval}'::interval
          ) AS date
        ),
        offers_data AS (
          SELECT
            DATE_TRUNC('${timeConfig.truncUnit}', o.created_at) as date,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE o.source = 'grails') as grails,
            COUNT(*) FILTER (WHERE o.source = 'opensea') as opensea
          ${fromClause}
          WHERE o.created_at > NOW() - INTERVAL '${timeConfig.interval}'
          ${hasClubFilter ? clubCondition.condition : ''}
          GROUP BY DATE_TRUNC('${timeConfig.truncUnit}', o.created_at)
        )
        SELECT
          ts.date,
          COALESCE(od.total, 0)::int as total,
          COALESCE(od.grails, 0)::int as grails,
          COALESCE(od.opensea, 0)::int as opensea
        FROM time_series ts
        LEFT JOIN offers_data od ON ts.date = od.date
        ORDER BY ts.date ASC`,
        clubCondition.params
      );

      const response: APIResponse = {
        success: true,
        data: {
          period: query.period,
          club: query.club || null,
          clubs: clubs.length > 0 ? clubs : null,
          points: result.rows.map(row => ({
            date: row.date.toISOString(),
            total: row.total,
            grails: row.grails,
            opensea: row.opensea,
          })),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch offers chart data',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
