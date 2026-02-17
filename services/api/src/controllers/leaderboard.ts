import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { getLeaderboardData } from '../services/leaderboard';
import type { LeaderboardQueryParams, ValidSortField } from '../types/leaderboard';

// Valid sort fields for validation
const VALID_SORT_FIELDS: ValidSortField[] = [
  'names_owned',
  'names_in_clubs',
  'expired_names',
  'names_listed',
  'names_sold',
  'sales_volume',
];

/**
 * Controller for handling leaderboard requests
 */
export async function getLeaderboard(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: Pool
): Promise<void> {
  try {
    const rawQuery = request.query as LeaderboardQueryParams;

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

    // Sorting - validate sortBy field
    const sortBy: ValidSortField = VALID_SORT_FIELDS.includes(rawQuery.sortBy as ValidSortField)
      ? (rawQuery.sortBy as ValidSortField)
      : 'names_owned';
    const sortOrder = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';

    // Validate sortBy parameter
    if (rawQuery.sortBy && !VALID_SORT_FIELDS.includes(rawQuery.sortBy as ValidSortField)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INVALID_SORT_FIELD',
          message: `Invalid sortBy field. Valid options are: ${VALID_SORT_FIELDS.join(', ')}`,
          validOptions: VALID_SORT_FIELDS,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Fetch leaderboard data
    const { users, total } = await getLeaderboardData(pool, {
      page: pageNum,
      limit: limitNum,
      sortBy,
      sortOrder,
      clubs: hasClubFilter ? clubs : undefined,
    });

    // Send response
    return reply.send({
      success: true,
      data: {
        users,
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
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch leaderboard',
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  }
}
