import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { getLeaderboardData } from '../services/leaderboard';
import type { LeaderboardQuery, LeaderboardResponse, LeaderboardError, SortByField } from '../types/leaderboard';

const VALID_SORT_FIELDS: SortByField[] = ['names_owned', 'names_in_clubs', 'expired_names', 'names_listed', 'names_sold', 'sales_volume'];

/**
 * Parse and validate query parameters
 */
function parseQueryParams(rawQuery: LeaderboardQuery) {
  // Parse clubs array filter
  let clubs: string[] = [];
  const rawClubs = rawQuery['clubs[]'];
  if (rawClubs) {
    clubs = Array.isArray(rawClubs) ? rawClubs : [rawClubs];
  }

  // Pagination
  const page = Math.max(1, parseInt(rawQuery.page || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(rawQuery.limit || '20')));

  // Sorting
  const sortBy: SortByField = VALID_SORT_FIELDS.includes(rawQuery.sortBy as SortByField)
    ? (rawQuery.sortBy as SortByField)
    : 'names_owned';
  const sortOrder = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';

  return {
    page,
    limit,
    sortBy,
    sortOrder: sortOrder as 'ASC' | 'DESC',
    clubs: clubs.length > 0 ? clubs : undefined,
    hasClubFilter: clubs.length > 0,
  };
}

/**
 * Get leaderboard handler
 */
export async function getLeaderboard(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: Pool
): Promise<void> {
  try {
    const rawQuery = request.query as LeaderboardQuery;
    const params = parseQueryParams(rawQuery);

    // Get leaderboard data
    const { total, users } = await getLeaderboardData(pool, {
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
      clubs: params.clubs,
    });

    const response: LeaderboardResponse = {
      success: true,
      data: {
        users,
      },
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        pages: Math.ceil(total / params.limit),
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        ...(params.hasClubFilter && { filters: { clubs: params.clubs! } }),
        sort: {
          by: params.sortBy,
          order: params.sortOrder.toLowerCase(),
        },
      },
    };

    reply.send(response);
  } catch (error) {
    request.log.error(error);
    const errorResponse: LeaderboardError = {
      success: false,
      error: 'Failed to fetch leaderboard',
    };
    reply.status(500).send(errorResponse);
  }
}
