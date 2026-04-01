import type { FastifyInstance } from 'fastify';
import { getPostgresPool, ENS_REFERRER_CODES } from '../../../shared/src';
import { veryLongCacheHandler } from '../middleware/cache';

// Program constants
const PROGRAM_START = '2026-04-01T00:00:00Z';
const SECONDS_PER_YEAR = 31556952; // Program-defined year length

// Find the grails referrer code from the shared config
const GRAILS_REFERRER = Object.entries(ENS_REFERRER_CODES).find(([, name]) => name === 'grails')![0];

// Valid sort fields
const VALID_SORT_FIELDS = ['points', 'registration_duration', 'renewal_duration', 'total_duration', 'total_eth_spend'] as const;

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
      const sortColumn = sortBy === 'total_eth_spend'
        ? 'total_eth_spend_wei::numeric'
        : sortBy === 'registration_duration'
          ? 'registration_duration_seconds'
          : sortBy === 'renewal_duration'
            ? 'renewal_duration_seconds'
            : 'total_duration_seconds';

      // For points, break ties by total_duration
      const tiebreaker = sortBy === 'points'
        ? ', total_duration_seconds DESC'
        : '';

      const dataQuery = `
        WITH registration_stats AS (
          SELECT
            registrant_address AS address,
            SUM(EXTRACT(EPOCH FROM (expiry_date - registration_date)))::bigint AS total_duration,
            SUM(total_cost_wei::numeric) AS total_cost,
            COUNT(*) AS entry_count
          FROM registrations
          WHERE referrer = $1
            AND registration_date >= $2::timestamptz
          GROUP BY registrant_address
        ),
        renewal_stats AS (
          SELECT
            renewer_address AS address,
            SUM(duration_seconds)::bigint AS total_duration,
            SUM(cost_wei::numeric) AS total_cost,
            COUNT(*) AS entry_count
          FROM renewals
          WHERE referrer = $1
            AND renewal_date >= $2::timestamptz
          GROUP BY renewer_address
        ),
        combined AS (
          SELECT
            COALESCE(reg.address, ren.address) AS address,
            COALESCE(reg.total_duration, 0) AS registration_duration_seconds,
            COALESCE(ren.total_duration, 0) AS renewal_duration_seconds,
            COALESCE(reg.total_duration, 0) + COALESCE(ren.total_duration, 0) AS total_duration_seconds,
            FLOOR((COALESCE(reg.total_duration, 0) + COALESCE(ren.total_duration, 0))::numeric / ${SECONDS_PER_YEAR})::int AS points,
            (COALESCE(reg.total_cost, 0) + COALESCE(ren.total_cost, 0))::text AS total_eth_spend_wei,
            COALESCE(reg.entry_count, 0)::int AS registration_count,
            COALESCE(ren.entry_count, 0)::int AS renewal_count
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
          WHERE referrer = $1 AND registration_date >= $2::timestamptz
          UNION
          SELECT renewer_address AS address FROM renewals
          WHERE referrer = $1 AND renewal_date >= $2::timestamptz
        ) unique_users
      `;

      const [dataResult, countResult] = await Promise.all([
        pool.query(dataQuery, [GRAILS_REFERRER, PROGRAM_START, limitNum, offset]),
        pool.query(countQuery, [GRAILS_REFERRER, PROGRAM_START]),
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
            total_eth_spend_wei: row.total_eth_spend_wei,
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
