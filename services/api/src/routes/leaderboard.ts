import type { FastifyInstance } from 'fastify';
import { getPostgresPool } from '../../../shared/src';
import { leaderboardCacheHandler } from '../middleware/cache';

// Valid sort fields for leaderboard
const VALID_SORT_FIELDS = ['names_owned', 'names_in_clubs', 'expired_names', 'names_listed', 'names_sold', 'sales_volume'] as const;

export async function leaderboardRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // Get user leaderboard - ranks users by ENS name holdings
  // GET /api/v1/leaderboard
  fastify.get('/', { preHandler: leaderboardCacheHandler }, async (request, reply) => {
    try {
      const rawQuery = request.query as {
        page?: string;
        limit?: string;
        sortBy?: string;
        sortOrder?: string;
        'clubs[]'?: string | string[];
      };

      // Parse clubs array filter
      let clubs: string[] = [];
      const rawClubs = rawQuery['clubs[]'];
      if (rawClubs) {
        clubs = Array.isArray(rawClubs) ? rawClubs : [rawClubs];
      }
      const hasClubFilter = clubs.length > 0;

      // Pagination
      const pageNum = Math.max(1, parseInt(rawQuery.page || '1'));
      const limitNum = Math.min(100, Math.max(1, parseInt(rawQuery.limit || '20')));
      const offset = (pageNum - 1) * limitNum;

      // Sorting
      const sortBy = VALID_SORT_FIELDS.includes(rawQuery.sortBy as typeof VALID_SORT_FIELDS[number])
        ? rawQuery.sortBy
        : 'names_owned';
      const sortOrder = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Build queries based on whether clubs filter is present
      let countQuery: string;
      let dataQuery: string;
      let countParams: unknown[];
      let dataParams: unknown[];

      if (hasClubFilter) {
        // With club filter: only include users who own active names in specified clubs
        countQuery = `
          SELECT COUNT(DISTINCT owner_address) as total
          FROM ens_names
          WHERE owner_address IS NOT NULL
            AND expiry_date > NOW() - INTERVAL '90 days'
            AND clubs && $1::text[]
        `;
        countParams = [clubs];

        dataQuery = `
          WITH filtered_owners AS (
            SELECT DISTINCT owner_address
            FROM ens_names
            WHERE owner_address IS NOT NULL
              AND expiry_date > NOW() - INTERVAL '90 days'
              AND clubs && $1::text[]
          ),
          owner_stats AS (
            SELECT
              e.owner_address,
              COUNT(*) FILTER (WHERE e.expiry_date > NOW() - INTERVAL '90 days') as names_owned,
              COUNT(*) FILTER (
                WHERE e.expiry_date > NOW() - INTERVAL '90 days'
                  AND e.clubs IS NOT NULL
                  AND array_length(e.clubs, 1) > 0
              ) as names_in_clubs,
              COUNT(*) FILTER (WHERE e.expiry_date <= NOW() - INTERVAL '90 days') as expired_names
            FROM ens_names e
            INNER JOIN filtered_owners fo ON fo.owner_address = e.owner_address
            GROUP BY e.owner_address
          ),
          owner_clubs AS (
            SELECT
              e.owner_address,
              COALESCE(array_agg(DISTINCT club ORDER BY club), ARRAY[]::text[]) as clubs
            FROM ens_names e
            INNER JOIN filtered_owners fo ON fo.owner_address = e.owner_address
            CROSS JOIN LATERAL unnest(e.clubs) as club
            WHERE e.expiry_date > NOW() - INTERVAL '90 days'
              AND e.clubs IS NOT NULL
            GROUP BY e.owner_address
          ),
          listing_stats AS (
            SELECT
              LOWER(l.seller_address) as owner_address,
              COUNT(*) as names_listed
            FROM listings l
            INNER JOIN filtered_owners fo ON LOWER(l.seller_address) = fo.owner_address
            WHERE l.status = 'active'
            GROUP BY LOWER(l.seller_address)
          ),
          sales_stats AS (
            SELECT
              LOWER(s.seller_address) as owner_address,
              COUNT(*) as names_sold,
              COALESCE(SUM(s.sale_price_wei::numeric), 0) as sales_volume
            FROM sales s
            INNER JOIN filtered_owners fo ON LOWER(s.seller_address) = fo.owner_address
            GROUP BY LOWER(s.seller_address)
          )
          SELECT
            s.owner_address as address,
            s.names_owned::int,
            s.names_in_clubs::int,
            s.expired_names::int,
            COALESCE(c.clubs, ARRAY[]::text[]) as clubs,
            COALESCE(ls.names_listed, 0)::int as names_listed,
            COALESCE(ss.names_sold, 0)::int as names_sold,
            COALESCE(ss.sales_volume, 0)::text as sales_volume
          FROM owner_stats s
          LEFT JOIN owner_clubs c ON c.owner_address = s.owner_address
          LEFT JOIN listing_stats ls ON ls.owner_address = s.owner_address
          LEFT JOIN sales_stats ss ON ss.owner_address = s.owner_address
          WHERE s.names_owned > 0
          ORDER BY ${sortBy === 'names_listed' ? 'COALESCE(ls.names_listed, 0)' : sortBy === 'names_sold' ? 'COALESCE(ss.names_sold, 0)' : sortBy === 'sales_volume' ? 'COALESCE(ss.sales_volume, 0)' : 's.' + sortBy} ${sortOrder} NULLS LAST, s.owner_address ASC
          LIMIT $2 OFFSET $3
        `;
        dataParams = [clubs, limitNum, offset];
      } else {
        // Without club filter: include all users with active names
        countQuery = `
          SELECT COUNT(DISTINCT owner_address) as total
          FROM ens_names
          WHERE owner_address IS NOT NULL
            AND expiry_date > NOW() - INTERVAL '90 days'
        `;
        countParams = [];

        dataQuery = `
          WITH owner_stats AS (
            SELECT
              owner_address,
              COUNT(*) FILTER (WHERE expiry_date > NOW() - INTERVAL '90 days') as names_owned,
              COUNT(*) FILTER (
                WHERE expiry_date > NOW() - INTERVAL '90 days'
                  AND clubs IS NOT NULL
                  AND array_length(clubs, 1) > 0
              ) as names_in_clubs,
              COUNT(*) FILTER (WHERE expiry_date <= NOW() - INTERVAL '90 days') as expired_names
            FROM ens_names
            WHERE owner_address IS NOT NULL
            GROUP BY owner_address
          ),
          owner_clubs AS (
            SELECT
              owner_address,
              COALESCE(array_agg(DISTINCT club ORDER BY club), ARRAY[]::text[]) as clubs
            FROM (
              SELECT owner_address, unnest(clubs) as club
              FROM ens_names
              WHERE owner_address IS NOT NULL
                AND expiry_date > NOW() - INTERVAL '90 days'
                AND clubs IS NOT NULL
                AND array_length(clubs, 1) > 0
            ) unnested
            GROUP BY owner_address
          ),
          listing_stats AS (
            SELECT
              LOWER(seller_address) as owner_address,
              COUNT(*) as names_listed
            FROM listings
            WHERE status = 'active'
            GROUP BY LOWER(seller_address)
          ),
          sales_stats AS (
            SELECT
              LOWER(seller_address) as owner_address,
              COUNT(*) as names_sold,
              COALESCE(SUM(sale_price_wei::numeric), 0) as sales_volume
            FROM sales
            GROUP BY LOWER(seller_address)
          )
          SELECT
            s.owner_address as address,
            s.names_owned::int,
            s.names_in_clubs::int,
            s.expired_names::int,
            COALESCE(c.clubs, ARRAY[]::text[]) as clubs,
            COALESCE(ls.names_listed, 0)::int as names_listed,
            COALESCE(ss.names_sold, 0)::int as names_sold,
            COALESCE(ss.sales_volume, 0)::text as sales_volume
          FROM owner_stats s
          LEFT JOIN owner_clubs c ON c.owner_address = s.owner_address
          LEFT JOIN listing_stats ls ON ls.owner_address = s.owner_address
          LEFT JOIN sales_stats ss ON ss.owner_address = s.owner_address
          WHERE s.names_owned > 0
          ORDER BY ${sortBy === 'names_listed' ? 'COALESCE(ls.names_listed, 0)' : sortBy === 'names_sold' ? 'COALESCE(ss.names_sold, 0)' : sortBy === 'sales_volume' ? 'COALESCE(ss.sales_volume, 0)' : 's.' + sortBy} ${sortOrder} NULLS LAST, s.owner_address ASC
          LIMIT $1 OFFSET $2
        `;
        dataParams = [limitNum, offset];
      }

      // Execute queries in parallel
      const [countResult, dataResult] = await Promise.all([
        pool.query(countQuery, countParams),
        pool.query(dataQuery, dataParams),
      ]);

      const total = parseInt(countResult.rows[0].total);

      return reply.send({
        success: true,
        data: {
          users: dataResult.rows.map(row => ({
            address: row.address,
            names_owned: row.names_owned,
            names_in_clubs: row.names_in_clubs,
            expired_names: row.expired_names,
            names_listed: row.names_listed,
            names_sold: row.names_sold,
            sales_volume: row.sales_volume,
            clubs: row.clubs,
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
          ...(hasClubFilter && { filters: { clubs } }),
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
        error: 'Failed to fetch leaderboard',
      });
    }
  });
}
