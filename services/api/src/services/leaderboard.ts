import type { Pool } from 'pg';
import type { SortByField, LeaderboardUser } from '../types/leaderboard';

export interface LeaderboardQueryParams {
  page: number;
  limit: number;
  sortBy: SortByField;
  sortOrder: 'ASC' | 'DESC';
  clubs?: string[];
}

interface LeaderboardStats {
  total: number;
  users: LeaderboardUser[];
}

/**
 * Get leaderboard data with club filtering
 */
async function getLeaderboardWithClubFilter(
  pool: Pool,
  params: LeaderboardQueryParams & { clubs: string[] }
): Promise<LeaderboardStats> {
  const { page, limit, sortBy, sortOrder, clubs } = params;
  const offset = (page - 1) * limit;

  const countQuery = `
    SELECT COUNT(DISTINCT owner_address) as total
    FROM ens_names
    WHERE owner_address IS NOT NULL
      AND expiry_date > NOW() - INTERVAL '90 days'
      AND clubs && $1::text[]
  `;

  const dataQuery = `
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
        COALESCE(SUM(CAST(s.sale_price_wei AS NUMERIC)) / 1e18, 0) as sales_volume
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
      COALESCE(ss.sales_volume, 0)::numeric as sales_volume
    FROM owner_stats s
    LEFT JOIN owner_clubs c ON c.owner_address = s.owner_address
    LEFT JOIN listing_stats ls ON ls.owner_address = s.owner_address
    LEFT JOIN sales_stats ss ON ss.owner_address = s.owner_address
    WHERE s.names_owned > 0
    ORDER BY ${buildOrderByClause(sortBy, sortOrder)}
    LIMIT $2 OFFSET $3
  `;

  const [countResult, dataResult] = await Promise.all([
    pool.query(countQuery, [clubs]),
    pool.query(dataQuery, [clubs, limit, offset]),
  ]);

  return {
    total: parseInt(countResult.rows[0].total),
    users: dataResult.rows.map(mapRowToUser),
  };
}

/**
 * Get leaderboard data without club filtering
 */
async function getLeaderboardWithoutClubFilter(
  pool: Pool,
  params: LeaderboardQueryParams
): Promise<LeaderboardStats> {
  const { page, limit, sortBy, sortOrder } = params;
  const offset = (page - 1) * limit;

  const countQuery = `
    SELECT COUNT(DISTINCT owner_address) as total
    FROM ens_names
    WHERE owner_address IS NOT NULL
      AND expiry_date > NOW() - INTERVAL '90 days'
  `;

  const dataQuery = `
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
        COALESCE(SUM(CAST(sale_price_wei AS NUMERIC)) / 1e18, 0) as sales_volume
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
      COALESCE(ss.sales_volume, 0)::numeric as sales_volume
    FROM owner_stats s
    LEFT JOIN owner_clubs c ON c.owner_address = s.owner_address
    LEFT JOIN listing_stats ls ON ls.owner_address = s.owner_address
    LEFT JOIN sales_stats ss ON ss.owner_address = s.owner_address
    WHERE s.names_owned > 0
    ORDER BY ${buildOrderByClause(sortBy, sortOrder)}
    LIMIT $1 OFFSET $2
  `;

  const [countResult, dataResult] = await Promise.all([
    pool.query(countQuery),
    pool.query(dataQuery, [limit, offset]),
  ]);

  return {
    total: parseInt(countResult.rows[0].total),
    users: dataResult.rows.map(mapRowToUser),
  };
}

/**
 * Build ORDER BY clause for different sort fields
 */
function buildOrderByClause(sortBy: SortByField, sortOrder: 'ASC' | 'DESC'): string {
  let orderByField: string;

  switch (sortBy) {
    case 'names_listed':
      orderByField = 'COALESCE(ls.names_listed, 0)';
      break;
    case 'names_sold':
      orderByField = 'COALESCE(ss.names_sold, 0)';
      break;
    case 'sales_volume':
      orderByField = 'COALESCE(ss.sales_volume, 0)';
      break;
    default:
      orderByField = `s.${sortBy}`;
  }

  return `${orderByField} ${sortOrder} NULLS LAST, s.owner_address ASC`;
}

/**
 * Map database row to LeaderboardUser
 */
function mapRowToUser(row: any): LeaderboardUser {
  return {
    address: row.address,
    names_owned: row.names_owned,
    names_in_clubs: row.names_in_clubs,
    expired_names: row.expired_names,
    names_listed: row.names_listed,
    names_sold: row.names_sold,
    sales_volume: parseFloat(row.sales_volume) || 0,
    clubs: row.clubs,
  };
}

/**
 * Get leaderboard data based on query parameters
 */
export async function getLeaderboardData(
  pool: Pool,
  params: LeaderboardQueryParams
): Promise<LeaderboardStats> {
  if (params.clubs && params.clubs.length > 0) {
    return getLeaderboardWithClubFilter(pool, { ...params, clubs: params.clubs });
  }
  return getLeaderboardWithoutClubFilter(pool, params);
}
