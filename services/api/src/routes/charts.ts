import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse, CURRENCY_ADDRESSES } from '../../../shared/src';

const ChartQuerySchema = z.object({
  period: z.enum(['1d', '7d', '30d', '1y', 'all']).default('7d'),
  club: z.string().optional(),
});

type ChartQuery = z.infer<typeof ChartQuerySchema>;

interface TimeConfig {
  interval: string;
  truncUnit: 'hour' | 'day';
  seriesInterval: string;
}

function getTimeConfig(period: string): TimeConfig {
  if (period === '1d') {
    return {
      interval: '24 hours',
      truncUnit: 'hour',
      seriesInterval: '1 hour',
    };
  }

  const intervalMap: Record<string, string> = {
    '7d': '7 days',
    '30d': '30 days',
    '1y': '1 year',
    'all': '100 years',
  };

  return {
    interval: intervalMap[period] || '7 days',
    truncUnit: 'day',
    seriesInterval: '1 day',
  };
}

function buildClubCondition(club: string | undefined, paramNum: number): { condition: string; params: any[] } {
  if (!club) {
    return { condition: '', params: [] };
  }

  if (club === 'any') {
    return {
      condition: 'AND array_length(en.clubs, 1) > 0',
      params: [],
    };
  }

  return {
    condition: `AND $${paramNum} = ANY(en.clubs)`,
    params: [club],
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
    const clubCondition = buildClubCondition(query.club, 1);

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
          FROM sales s
          JOIN ens_names en ON s.ens_name_id = en.id
          WHERE s.sale_date > NOW() - INTERVAL '${timeConfig.interval}'
          ${clubCondition.condition}
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
    const clubCondition = buildClubCondition(query.club, 3);

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
          FROM sales s
          JOIN ens_names en ON s.ens_name_id = en.id
          WHERE s.sale_date > NOW() - INTERVAL '${timeConfig.interval}'
            AND (s.currency_address = $1 OR s.currency_address = $2)
          ${clubCondition.condition}
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
    const clubCondition = buildClubCondition(query.club, 1);

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
          FROM listings l
          JOIN ens_names en ON l.ens_name_id = en.id
          WHERE l.created_at > NOW() - INTERVAL '${timeConfig.interval}'
          ${clubCondition.condition}
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
   * GET /charts/offers
   * Get count of offers created per time bucket with source breakdown
   */
  fastify.get('/offers', async (request, reply) => {
    const query = ChartQuerySchema.parse(request.query);
    const timeConfig = getTimeConfig(query.period);
    const clubCondition = buildClubCondition(query.club, 1);

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
          FROM offers o
          JOIN ens_names en ON o.ens_name_id = en.id
          WHERE o.created_at > NOW() - INTERVAL '${timeConfig.interval}'
          ${clubCondition.condition}
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
