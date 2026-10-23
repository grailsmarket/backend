import type { FastifyInstance } from 'fastify';
import { getPostgresPool, ENS_REFERRER_CODES } from '../../../shared/src';
import { veryLongCacheHandler } from '../middleware/cache';

// Program constants
const PROGRAM_START = '2026-04-01T00:00:00Z';
const SECONDS_PER_YEAR = 31556952; // Program-defined year length

// Every grails referrer code from the shared config: the legacy one and the current one
// (used by BulkRegistrationV2 for ENSv2 registrations and renewals)
const GRAILS_REFERRERS = Object.entries(ENS_REFERRER_CODES)
  .filter(([, name]) => name === 'grails')
  .map(([code]) => code);

// Valid sort fields
const VALID_SORT_FIELDS = ['points', 'registration_duration', 'renewal_duration', 'total_duration', 'total_eth_spend', 'total_usd_spend', 'base_cost_usd', 'base_cost_eth'] as const;

export async function awardsLeaderboardRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // GET /api/v1/awards-leaderboard
  fastify.get('/', { preHandler: veryLongCacheHandler }, async (request, reply) => {
    try {
      const rawQuery = request.query as {
        page?: string;
        limit?: string;
        sortBy?: string;
        sortOrder?: string;
      };

      // Pagination
      const pageNum = Math.max(1, parseInt(rawQuery.page || '1'));
      const limitNum = Math.min(100, Math.max(1, parseInt(rawQuery.limit || '20')));
      const offset = (pageNum - 1) * limitNum;

      // Sorting
      const sortBy = VALID_SORT_FIELDS.includes(rawQuery.sortBy as typeof VALID_SORT_FIELDS[number])
        ? rawQuery.sortBy
        : 'points';
      const sortOrder = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Map sort field to column in the combined CTE
      const sortColumnMap: Record<string, string> = {
        total_eth_spend: 'total_eth_spend_wei::numeric',
        total_usd_spend: 'total_usd_spend',
        registration_duration: 'registration_duration_seconds',
        renewal_duration: 'renewal_duration_seconds',
        base_cost_usd: 'base_cost_usd',
        base_cost_eth: 'base_cost_eth',
      };
      const sortColumn = sortColumnMap[sortBy!] || 'total_duration_seconds';

      // For points, break ties by total_duration
      const tiebreaker = sortBy === 'points'
        ? ', total_duration_seconds DESC'
        : '';

      const dataQuery = `
        WITH registration_rows AS (
          SELECT
            r.registrant_address AS address,
            EXTRACT(EPOCH FROM (r.expiry_date - r.registration_date)) AS duration_seconds,
            -- ETH spend counts ETH-paid (v1) registrations; v2 ones are paid in stablecoins and
            -- show up in the USD spend, which covers both
            CASE WHEN r.currency_address IS NULL THEN r.total_cost_wei::numeric END AS cost_wei,
            r.total_cost_usd AS cost_usd,
            pf.price AS eth_usd_price
          FROM registrations r
          LEFT JOIN LATERAL (
            SELECT price FROM price_feeds
            WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
              AND timestamp <= r.registration_date
            ORDER BY timestamp DESC LIMIT 1
          ) pf ON true
          WHERE r.referrer = ANY($1::text[])
            AND r.registration_date >= $2::timestamptz
        ),
        registration_stats AS (
          SELECT
            address,
            SUM(duration_seconds)::bigint AS total_duration,
            SUM(cost_wei) AS total_cost,
            SUM(cost_usd) AS total_cost_usd,
            COUNT(*) AS entry_count,
            SUM(duration_seconds / ${SECONDS_PER_YEAR}::numeric * 5 / NULLIF(eth_usd_price, 0)) AS base_cost_eth
          FROM registration_rows
          GROUP BY address
        ),
        renewal_rows AS (
          SELECT
            rn.renewer_address AS address,
            COALESCE(rn.duration_seconds, 0) AS duration_seconds,
            CASE WHEN rn.currency_address IS NULL THEN rn.cost_wei::numeric END AS cost_wei,
            rn.cost_usd AS cost_usd,
            pf.price AS eth_usd_price
          FROM renewals rn
          LEFT JOIN LATERAL (
            SELECT price FROM price_feeds
            WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
              AND timestamp <= rn.renewal_date
            ORDER BY timestamp DESC LIMIT 1
          ) pf ON true
          WHERE rn.referrer = ANY($1::text[])
            AND rn.renewal_date >= $2::timestamptz
        ),
        renewal_stats AS (
          SELECT
            address,
            SUM(duration_seconds)::bigint AS total_duration,
            SUM(cost_wei) AS total_cost,
            SUM(cost_usd) AS total_cost_usd,
            COUNT(*) AS entry_count,
            SUM(duration_seconds::numeric / ${SECONDS_PER_YEAR}::numeric * 5 / NULLIF(eth_usd_price, 0)) AS base_cost_eth
          FROM renewal_rows
          GROUP BY address
        ),
        combined AS (
          SELECT
            COALESCE(reg.address, ren.address) AS address,
            COALESCE(reg.total_duration, 0) AS registration_duration_seconds,
            COALESCE(ren.total_duration, 0) AS renewal_duration_seconds,
            COALESCE(reg.total_duration, 0) + COALESCE(ren.total_duration, 0) AS total_duration_seconds,
            FLOOR((COALESCE(reg.total_duration, 0) + COALESCE(ren.total_duration, 0))::numeric / ${SECONDS_PER_YEAR})::int AS points,
            (COALESCE(reg.total_cost, 0) + COALESCE(ren.total_cost, 0))::text AS total_eth_spend_wei,
            ROUND(COALESCE(reg.total_cost_usd, 0) + COALESCE(ren.total_cost_usd, 0), 2) AS total_usd_spend,
            COALESCE(reg.entry_count, 0)::int AS registration_count,
            COALESCE(ren.entry_count, 0)::int AS renewal_count,
            ROUND((COALESCE(reg.total_duration, 0) + COALESCE(ren.total_duration, 0))::numeric / ${SECONDS_PER_YEAR} * 5, 2) AS base_cost_usd,
            ROUND(COALESCE(reg.base_cost_eth, 0) + COALESCE(ren.base_cost_eth, 0), 8) AS base_cost_eth
          FROM registration_stats reg
          FULL OUTER JOIN renewal_stats ren ON reg.address = ren.address
        )
        SELECT * FROM combined
        ORDER BY ${sortColumn} ${sortOrder}${tiebreaker}, address ASC
        LIMIT $3 OFFSET $4
      `;

      const countQuery = `
        SELECT COUNT(*) AS total FROM (
          SELECT registrant_address AS address FROM registrations
          WHERE referrer = ANY($1::text[]) AND registration_date >= $2::timestamptz
          UNION
          SELECT renewer_address AS address FROM renewals
          WHERE referrer = ANY($1::text[]) AND renewal_date >= $2::timestamptz
        ) unique_users
      `;

      const [dataResult, countResult] = await Promise.all([
        pool.query(dataQuery, [GRAILS_REFERRERS, PROGRAM_START, limitNum, offset]),
        pool.query(countQuery, [GRAILS_REFERRERS, PROGRAM_START]),
      ]);

      const total = parseInt(countResult.rows[0].total);

      return reply.send({
        success: true,
        data: {
          users: dataResult.rows.map((row, index) => ({
            rank: offset + index + 1,
            address: row.address,
            points: row.points,
            registration_duration_seconds: Number(row.registration_duration_seconds),
            renewal_duration_seconds: Number(row.renewal_duration_seconds),
            total_duration_seconds: Number(row.total_duration_seconds),
            total_duration_years: Number(row.total_duration_seconds) / SECONDS_PER_YEAR,
            total_eth_spend_wei: row.total_eth_spend_wei,
            total_usd_spend: Number(row.total_usd_spend),
            base_cost_usd: Number(row.base_cost_usd),
            base_cost_eth: Number(row.base_cost_eth),
            registration_count: row.registration_count,
            renewal_count: row.renewal_count,
          })),
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          program_start: PROGRAM_START,
          seconds_per_year: SECONDS_PER_YEAR,
          sort: {
            by: sortBy,
            order: sortOrder.toLowerCase(),
          },
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch awards leaderboard',
      });
    }
  });
}
