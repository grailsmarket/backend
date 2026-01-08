import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { searchNames } from '../services/search';
import { veryLongCacheHandler, cacheHandler } from '../middleware/cache';

// Valid sort fields for clubs
const VALID_SORT_FIELDS = [
  'total_sales_volume_wei',
  'sales_volume_wei_1y',
  'sales_volume_wei_1mo',
  'sales_volume_wei_1w',
  'total_sales_count',
  'sales_count_1y',
  'sales_count_1mo',
  'sales_count_1w',
  'member_count',
  'floor_price_wei',
  'name',
] as const;

// Valid classifications for filtering
const VALID_CLASSIFICATIONS = [
  'ethmojis',
  'digits',
  'palindromes',
  'prepunk',
  'geo',
  'letters',
] as const;

// Volume/price fields that need numeric casting for sorting
const NUMERIC_SORT_FIELDS = [
  'total_sales_volume_wei',
  'sales_volume_wei_1y',
  'sales_volume_wei_1mo',
  'sales_volume_wei_1w',
  'floor_price_wei',
];

export async function clubsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  // Get all clubs with metadata, filtering, sorting, and search
  fastify.get('/', { preHandler: veryLongCacheHandler }, async (request, reply) => {
    try {
      const rawQuery = request.query as {
        sortBy?: string;
        sortOrder?: string;
        'class[]'?: string | string[];
        search?: string;
      };

      // Parse class array (classifications filter)
      let classifications: string[] = [];
      const rawClass = rawQuery['class[]'];
      if (rawClass) {
        classifications = Array.isArray(rawClass)
          ? rawClass
          : [rawClass];
        // Filter to valid classifications only
        classifications = classifications.filter((c) =>
          VALID_CLASSIFICATIONS.includes(c as typeof VALID_CLASSIFICATIONS[number])
        );
      }

      // Validate sort field
      const sortBy = VALID_SORT_FIELDS.includes(rawQuery.sortBy as typeof VALID_SORT_FIELDS[number])
        ? rawQuery.sortBy
        : 'total_sales_volume_wei';
      const sortOrder = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';
      const search = rawQuery.search?.trim();

      // Build WHERE clause
      const whereConditions: string[] = [];
      const params: unknown[] = [];
      let paramCount = 1;

      // Classification filter (array overlap)
      if (classifications.length > 0) {
        whereConditions.push(`classifications && $${paramCount}::text[]`);
        params.push(classifications);
        paramCount++;
      }

      // Search filter (wildcard on name and description)
      if (search) {
        whereConditions.push(`(name ILIKE $${paramCount} OR description ILIKE $${paramCount})`);
        params.push(`%${search}%`);
        paramCount++;
      }

      const whereClause = whereConditions.length > 0
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';

      // Build ORDER BY clause with numeric casting for volume/price fields
      const orderByField = NUMERIC_SORT_FIELDS.includes(sortBy!)
        ? `${sortBy}::numeric`
        : sortBy;
      const orderByClause = `ORDER BY ${orderByField} ${sortOrder} NULLS LAST, name ASC`;

      const query = `
        SELECT
          name,
          description,
          member_count,
          floor_price_wei,
          floor_price_currency,
          total_sales_count,
          total_sales_volume_wei,
          sales_count_1y,
          sales_count_1mo,
          sales_count_1w,
          sales_volume_wei_1y,
          sales_volume_wei_1mo,
          sales_volume_wei_1w,
          classifications,
          last_floor_update,
          last_sales_update,
          created_at,
          updated_at
        FROM clubs
        ${whereClause}
        ${orderByClause}
      `;

      const result = await pool.query(query, params);

      const response: APIResponse = {
        success: true,
        data: {
          clubs: result.rows,
          total: result.rows.length,
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
        error: 'Failed to fetch clubs',
      });
    }
  });

  // Get names in a specific club
  fastify.get('/:clubName', { preHandler: cacheHandler }, async (request, reply) => {
    const { clubName } = request.params as { clubName: string };
    const { page = '1', limit = '20' } = request.query as { page?: string; limit?: string };

    try {
      // Get club info
      const clubQuery = `
        SELECT
          name,
          description,
          member_count,
          floor_price_wei,
          floor_price_currency,
          total_sales_count,
          total_sales_volume_wei,
          sales_count_1y,
          sales_count_1mo,
          sales_count_1w,
          sales_volume_wei_1y,
          sales_volume_wei_1mo,
          sales_volume_wei_1w,
          classifications,
          last_floor_update,
          last_sales_update,
          created_at
        FROM clubs
        WHERE name = $1
      `;
      const clubResult = await pool.query(clubQuery, [clubName]);

      if (clubResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'Club not found',
        });
      }

      const club = clubResult.rows[0];

      // Search for names in this club using the search service
      const searchResults = await searchNames({
        q: '*',
        page: parseInt(page),
        limit: parseInt(limit),
        filters: {
          clubs: [clubName],
        },
      });

      const response: APIResponse = {
        success: true,
        data: {
          club,
          names: searchResults.results,
          pagination: searchResults.pagination,
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
        error: 'Failed to fetch club names',
      });
    }
  });

  // Get club counts for an owner address
  fastify.get<{
    Params: { address: string };
  }>('/counts/:address', async (request, reply) => {
    const { address } = request.params;

    // Basic address validation
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'INVALID_ADDRESS',
          message: 'Invalid Ethereum address format',
        },
      });
    }

    try {
      const result = await pool.query(
        `
        WITH owner_names AS (
          SELECT id, clubs
          FROM ens_names
          WHERE LOWER(owner_address) = LOWER($1)
        ),
        any_count AS (
          SELECT 'any' AS club_name, COUNT(*)::int AS count, 0 AS sort_order
          FROM owner_names
          WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0
        ),
        club_counts AS (
          SELECT c.name AS club_name, COUNT(on2.id)::int AS count, 1 AS sort_order
          FROM clubs c
          LEFT JOIN owner_names on2 ON c.name = ANY(on2.clubs)
          GROUP BY c.name
        )
        SELECT club_name, count FROM (
          SELECT * FROM any_count
          UNION ALL
          SELECT * FROM club_counts
        ) AS combined
        ORDER BY sort_order, count DESC, club_name
        `,
        [address]
      );

      // Transform to object
      const counts: Record<string, number> = {};
      for (const row of result.rows) {
        counts[row.club_name] = row.count;
      }

      return reply.send({
        success: true,
        data: counts,
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch club counts',
      });
    }
  });
}
