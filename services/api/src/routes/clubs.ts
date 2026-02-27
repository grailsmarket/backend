import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPostgresPool, type APIResponse, getFile, isStorageEnabled } from '../../../shared/src';
import { searchNames } from '../services/search';
import { buildSearchResults, createUnregisteredPlaceholder, type SearchResult } from '../utils/response-builder';
import { veryLongCacheHandler, cacheHandler } from '../middleware/cache';

// In-memory cache for S3 images
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IMAGE_CACHE_MAX = 120;
interface CachedImage {
  body: Buffer;
  contentType: string;
  cachedAt: number;
}
const imageCache = new Map<string, CachedImage>();

function evictStaleImages() {
  const now = Date.now();
  for (const [key, entry] of imageCache) {
    if (now - entry.cachedAt > IMAGE_CACHE_TTL_MS) {
      imageCache.delete(key);
    }
  }
  // If still at capacity, delete oldest
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of imageCache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) imageCache.delete(oldestKey);
  }
}

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
  'total_reg_count',
  'reg_count_1y',
  'reg_count_1mo',
  'reg_count_1w',
  'member_count',
  'floor_price_wei',
  'name',
  'registered_count',
  'grace_count',
  'listings_count',
  'registered_percent',
  'grace_percent',
  'listings_percent',
  'premium_count',
  'available_count',
  'premium_percent',
  'available_percent',
  'holders_count',
  'holders_ratio',
] as const;

// Valid classifications for filtering
const VALID_CLASSIFICATIONS = [
  'ethmojis',
  'digits',
  'palindromes',
  'prepunk',
  'geo',
  'letters',
  'fantasy',
  'crypto'
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
        whereConditions.push(`c.classifications && $${paramCount}::text[]`);
        params.push(classifications);
        paramCount++;
      }

      // Search filter (wildcard on name and description)
      if (search) {
        whereConditions.push(`(c.name ILIKE $${paramCount} OR c.description ILIKE $${paramCount} OR c.display_name ILIKE $${paramCount})`);
        params.push(`%${search}%`);
        paramCount++;
      }

      const whereClause = whereConditions.length > 0
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';

      // Build ORDER BY clause with numeric casting for volume/price fields
      // and computed expressions for percentage/ratio fields
      let orderByField: string;
      const computedFields = [
        'registered_percent',
        'grace_percent',
        'listings_percent',
        'premium_percent',
        'available_percent',
        'holders_count',
        'holders_ratio',
      ];
      if (computedFields.includes(sortBy!)) {
        orderByField = sortBy!;
      } else if (NUMERIC_SORT_FIELDS.includes(sortBy!)) {
        orderByField = `${sortBy}::numeric`;
      } else {
        orderByField = sortBy!;
      }
      const orderByClause = `ORDER BY ${orderByField} ${sortOrder} NULLS LAST, name ASC`;

      const query = `
        SELECT
          c.name,
          c.display_name,
          c.description,
          c.member_count,
          c.floor_price_wei,
          c.floor_price_currency,
          c.total_sales_count,
          c.total_sales_volume_wei,
          c.sales_count_1y,
          c.sales_count_1mo,
          c.sales_count_1w,
          c.sales_volume_wei_1y,
          c.sales_volume_wei_1mo,
          c.sales_volume_wei_1w,
          c.total_reg_count,
          c.reg_count_1y,
          c.reg_count_1mo,
          c.reg_count_1w,
          c.registered_count,
          c.grace_count,
          c.listings_count,
          ROUND((c.registered_count::numeric / NULLIF(c.member_count, 0)) * 100, 2)::double precision AS registered_percent,
          ROUND((c.grace_count::numeric / NULLIF(c.member_count, 0)) * 100, 2)::double precision AS grace_percent,
          ROUND((c.listings_count::numeric / NULLIF(c.member_count, 0)) * 100, 2)::double precision AS listings_percent,
          c.premium_count,
          c.available_count,
          ROUND((c.premium_count::numeric / NULLIF(c.member_count, 0)) * 100, 2)::double precision AS premium_percent,
          ROUND((c.available_count::numeric / NULLIF(c.member_count, 0)) * 100, 2)::double precision AS available_percent,
          c.classifications,
          c.avatar_image_key,
          c.header_image_key,
          c.last_floor_update,
          c.last_sales_update,
          c.created_at,
          c.updated_at,
          COALESCE(h.holders_count, 0)::integer AS holders_count,
          ROUND((COALESCE(h.holders_count, 0)::numeric / NULLIF(c.member_count, 0)) * 100, 2)::double precision AS holders_ratio
        FROM clubs c
        LEFT JOIN (
          SELECT
            unnest(clubs) as club_name,
            COUNT(DISTINCT owner_address) as holders_count
          FROM ens_names
          WHERE owner_address IS NOT NULL
            AND expiry_date > NOW() - INTERVAL '90 days'
          GROUP BY unnest(clubs)
        ) h ON h.club_name = c.name
        ${whereClause}
        ${orderByClause}
      `;

      const result = await pool.query(query, params);

      const response: APIResponse = {
        success: true,
        data: {
          clubs: result.rows.map(club => ({
            ...club,
            avatar_url: club.avatar_image_key ? `/api/v1/clubs/${club.name}/avatar` : null,
            header_url: club.header_image_key ? `/api/v1/clubs/${club.name}/header` : null,
          })),
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

  // Get aggregated holders across clubs (must be before /:clubName to avoid route conflict)
  fastify.get('/holders', { preHandler: cacheHandler }, async (request, reply) => {
    try {
      const rawQuery = request.query as {
        page?: string;
        limit?: string;
        sortOrder?: string;
        'clubs[]'?: string | string[];
      };

      // Parse clubs array
      let clubs: string[] = [];
      const rawClubs = rawQuery['clubs[]'];
      if (rawClubs) {
        clubs = Array.isArray(rawClubs) ? rawClubs : [rawClubs];
      }

      const pageNum = Math.max(1, parseInt(rawQuery.page || '1'));
      const limitNum = Math.min(100, Math.max(1, parseInt(rawQuery.limit || '20')));
      const offset = (pageNum - 1) * limitNum;
      const order = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Build WHERE clause - if no clubs specified, match any club
      const hasClubFilter = clubs.length > 0;
      const clubFilter = hasClubFilter
        ? 'clubs && $1::text[]'  // Array overlap with selected clubs
        : 'clubs IS NOT NULL AND array_length(clubs, 1) > 0';  // Any club

      // Get unique holder count (deduplicated across clubs)
      // Include registered and grace period names, exclude premium and available
      const countQuery = `
        SELECT COUNT(DISTINCT owner_address) as unique_holders
        FROM ens_names
        WHERE ${clubFilter}
          AND owner_address IS NOT NULL
          AND expiry_date > NOW() - INTERVAL '90 days'
      `;

      // Get paginated holders with deduplicated name counts
      // Include registered and grace period names, exclude premium and available
      const holdersQuery = `
        SELECT
          owner_address as address,
          COUNT(DISTINCT id) as name_count
        FROM ens_names
        WHERE ${clubFilter}
          AND owner_address IS NOT NULL
          AND expiry_date > NOW() - INTERVAL '90 days'
        GROUP BY owner_address
        ORDER BY name_count ${order}, owner_address ASC
        LIMIT $${hasClubFilter ? 2 : 1} OFFSET $${hasClubFilter ? 3 : 2}
      `;

      // Build params based on whether clubs filter is present
      const countParams = hasClubFilter ? [clubs] : [];
      const holdersParams = hasClubFilter
        ? [clubs, limitNum, offset]
        : [limitNum, offset];

      // If no clubs filter, get all club names for the response
      const allClubsQuery = 'SELECT name FROM clubs ORDER BY name';

      const [countResult, holdersResult, allClubsResult] = await Promise.all([
        pool.query(countQuery, countParams),
        pool.query(holdersQuery, holdersParams),
        hasClubFilter ? Promise.resolve({ rows: [] }) : pool.query(allClubsQuery),
      ]);

      const uniqueHolders = parseInt(countResult.rows[0].unique_holders);
      const responseClubs = hasClubFilter
        ? clubs
        : allClubsResult.rows.map(row => row.name);

      return reply.send({
        success: true,
        data: {
          clubs: responseClubs,
          unique_holders: uniqueHolders,
          holders: holdersResult.rows.map(row => ({
            address: row.address,
            name_count: parseInt(row.name_count),
          })),
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: uniqueHolders,
          pages: Math.ceil(uniqueHolders / limitNum),
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch club holders',
      });
    }
  });

  // Serve club image from S3 (avatar or header)
  async function serveClubImage(request: FastifyRequest, reply: FastifyReply, imageType: 'avatar' | 'header') {
    const { clubName } = request.params as { clubName: string };

    try {
      const column = imageType === 'avatar' ? 'avatar_image_key' : 'header_image_key';
      const result = await pool.query(`SELECT ${column} FROM clubs WHERE name = $1`, [clubName]);

      if (result.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Club not found' });
      }

      const imageKey = result.rows[0][column];
      if (!imageKey) {
        return reply.status(404).send({ success: false, error: 'No image set' });
      }

      // Check in-memory cache
      const cached = imageCache.get(imageKey);
      if (cached && Date.now() - cached.cachedAt < IMAGE_CACHE_TTL_MS) {
        return reply
          .header('Content-Type', cached.contentType)
          .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
          .send(cached.body);
      }

      if (!isStorageEnabled()) {
        return reply.status(503).send({ success: false, error: 'Storage not configured' });
      }

      const file = await getFile(imageKey);
      if (!file) {
        return reply.status(404).send({ success: false, error: 'Image not found' });
      }

      // Cache in memory
      evictStaleImages();
      imageCache.set(imageKey, { body: file.body, contentType: file.contentType, cachedAt: Date.now() });

      return reply
        .header('Content-Type', file.contentType)
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
        .send(file.body);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: 'Failed to serve image' });
    }
  }

  // Club avatar image proxy
  fastify.get('/:clubName/avatar', async (request, reply) => {
    return serveClubImage(request, reply, 'avatar');
  });

  // Club header image proxy
  fastify.get('/:clubName/header', async (request, reply) => {
    return serveClubImage(request, reply, 'header');
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
          display_name,
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
          total_reg_count,
          reg_count_1y,
          reg_count_1mo,
          reg_count_1w,
          classifications,
          avatar_image_key,
          header_image_key,
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

      const club = {
        ...clubResult.rows[0],
        avatar_url: clubResult.rows[0].avatar_image_key ? `/api/v1/clubs/${clubName}/avatar` : null,
        header_url: clubResult.rows[0].header_image_key ? `/api/v1/clubs/${clubName}/header` : null,
      };

      // Query club members directly from club_memberships LEFT JOIN ens_names
      // This includes both registered and unregistered names
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      const namesQuery = `
        SELECT cm.ens_name as name, (en.id IS NOT NULL) as is_registered
        FROM club_memberships cm
        LEFT JOIN ens_names en ON LOWER(cm.ens_name) = LOWER(en.name)
        WHERE cm.club_name = $1
          AND cm.ens_name NOT LIKE '%.%.eth'
          AND cm.ens_name NOT LIKE 'token-%'
          AND cm.ens_name NOT LIKE '[%'
        ORDER BY cm.ens_name ASC
        LIMIT $2 OFFSET $3
      `;
      const namesResult = await pool.query(namesQuery, [clubName, limitNum, offset]);

      // Use member_count from club metadata for total (already maintained by trigger)
      const totalMembers = club.member_count || 0;
      const totalPages = Math.ceil(totalMembers / limitNum);

      // Split into registered and unregistered
      const registeredNames = namesResult.rows
        .filter((row: any) => row.is_registered)
        .map((row: any) => row.name);

      const registeredResults = await buildSearchResults(registeredNames);
      const registeredMap = new Map(
        registeredResults.map(r => [r.name.toLowerCase(), r])
      );

      // Fetch all clubs for unregistered names
      const unregisteredNames = namesResult.rows
        .filter((row: any) => !row.is_registered)
        .map((row: any) => row.name);

      let unregisteredClubsMap = new Map<string, string[]>();
      if (unregisteredNames.length > 0) {
        const clubsResult = await pool.query(
          `SELECT ens_name, array_agg(club_name) as clubs
           FROM club_memberships
           WHERE ens_name = ANY($1)
           GROUP BY ens_name`,
          [unregisteredNames]
        );
        for (const row of clubsResult.rows) {
          unregisteredClubsMap.set(row.ens_name.toLowerCase(), row.clubs);
        }
      }

      // Merge in query order
      const nameResults: SearchResult[] = namesResult.rows.map((row: any) => {
        if (row.is_registered) {
          return registeredMap.get(row.name.toLowerCase());
        } else {
          const nameClubs = unregisteredClubsMap.get(row.name.toLowerCase()) || [clubName];
          return createUnregisteredPlaceholder(row.name, nameClubs);
        }
      }).filter((r): r is SearchResult => r !== undefined);

      const response: APIResponse = {
        success: true,
        data: {
          club,
          names: nameResults,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalMembers,
            totalPages,
            hasNext: pageNum < totalPages,
            hasPrev: pageNum > 1,
          },
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

  // Get holders for a specific club
  fastify.get('/:clubName/holders', { preHandler: cacheHandler }, async (request, reply) => {
    const { clubName } = request.params as { clubName: string };
    const rawQuery = request.query as {
      page?: string;
      limit?: string;
      sortOrder?: string;
    };

    try {
      const pageNum = Math.max(1, parseInt(rawQuery.page || '1'));
      const limitNum = Math.min(100, Math.max(1, parseInt(rawQuery.limit || '20')));
      const offset = (pageNum - 1) * limitNum;
      const order = rawQuery.sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Verify club exists
      const clubCheck = await pool.query('SELECT name FROM clubs WHERE name = $1', [clubName]);
      if (clubCheck.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'Club not found',
        });
      }

      // Get unique holder count
      // Include registered and grace period names, exclude premium and available
      const countQuery = `
        SELECT COUNT(DISTINCT owner_address) as unique_holders
        FROM ens_names
        WHERE $1 = ANY(clubs)
          AND owner_address IS NOT NULL
          AND expiry_date > NOW() - INTERVAL '90 days'
      `;

      // Get paginated holders with name counts
      // Include registered and grace period names, exclude premium and available
      const holdersQuery = `
        SELECT
          owner_address as address,
          COUNT(*) as name_count
        FROM ens_names
        WHERE $1 = ANY(clubs)
          AND owner_address IS NOT NULL
          AND expiry_date > NOW() - INTERVAL '90 days'
        GROUP BY owner_address
        ORDER BY name_count ${order}, owner_address ASC
        LIMIT $2 OFFSET $3
      `;

      const [countResult, holdersResult] = await Promise.all([
        pool.query(countQuery, [clubName]),
        pool.query(holdersQuery, [clubName, limitNum, offset]),
      ]);

      const uniqueHolders = parseInt(countResult.rows[0].unique_holders);

      return reply.send({
        success: true,
        data: {
          clubs: [clubName],
          unique_holders: uniqueHolders,
          holders: holdersResult.rows.map(row => ({
            address: row.address,
            name_count: parseInt(row.name_count),
          })),
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: uniqueHolders,
          pages: Math.ceil(uniqueHolders / limitNum),
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch club holders',
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

  // Get club counts for names in premium or available status
  fastify.get<{
    Params: { status: string };
  }>('/counts/:status(premium|available)', async (request, reply) => {
    const { status } = request.params;

    try {
      // Build the date filter based on status
      // Premium: expired 90-111 days ago
      // Available: expired > 111 days ago
      const dateFilter = status === 'premium'
        ? `expiry_date <= NOW() - INTERVAL '90 days' AND expiry_date > NOW() - INTERVAL '111 days'`
        : `expiry_date <= NOW() - INTERVAL '111 days'`;

      const result = await pool.query(
        `
        WITH status_names AS (
          SELECT id, clubs
          FROM ens_names
          WHERE ${dateFilter}
            AND clubs IS NOT NULL
            AND array_length(clubs, 1) > 0
        ),
        any_count AS (
          SELECT 'any' AS club_name, COUNT(*)::int AS count, 0 AS sort_order
          FROM status_names
        ),
        club_counts AS (
          SELECT c.name AS club_name, COUNT(sn.id)::int AS count, 1 AS sort_order
          FROM clubs c
          LEFT JOIN status_names sn ON c.name = ANY(sn.clubs)
          GROUP BY c.name
        )
        SELECT club_name, count FROM (
          SELECT * FROM any_count
          UNION ALL
          SELECT * FROM club_counts
        ) AS combined
        ORDER BY sort_order, count DESC, club_name
        `
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
        error: `Failed to fetch ${status} club counts`,
      });
    }
  });
}
