import { FastifyInstance } from 'fastify';
import { getPostgresPool, getElasticsearchClient, APIResponse } from '../../../shared/src';
import { buildSearchResults, SearchResult } from '../utils/response-builder';
import { buildESFilters, buildESSort, calculateMinScore } from '../utils/elasticsearch-filters';
import { optionalAuth } from '../middleware/auth';
import { z } from 'zod';

// Schema for bulk exact search request
const BulkExactSearchSchema = z.object({
  terms: z.array(z.string().min(1)).min(1).max(1000),
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// Placeholder result for terms not found in bulk exact search
function createNotFoundResult(name: string): SearchResult {
  // Ensure name has .eth suffix
  const normalizedName = name.toLowerCase().endsWith('.eth') ? name : `${name}.eth`;
  return {
    id: 0,
    name: normalizedName,
    token_id: '',
    owner: '',
    expiry_date: null,
    registration_date: null,
    last_sale_date: null,
    metadata: {},
    clubs: [],
    has_numbers: false,
    has_emoji: false,
    last_sale_price: null,
    last_sale_currency: null,
    last_sale_price_usd: null,
    listings: [],
    upvotes: 0,
    downvotes: 0,
    net_score: 0,
    watchers_count: 0,
    is_user_watching: false,
    highest_offer_wei: null,
    highest_offer_currency: null,
    highest_offer_id: null,
    view_count: 0,
  };
}

export async function searchRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const es = getElasticsearchClient();

  // Global search endpoint - searches all ENS names by default
  // Set showListings=true to limit results to only names with active listings
  // Set showUnlisted=true to limit results to only names WITHOUT active listings
  fastify.get('/', { preHandler: optionalAuth }, async (request, reply) => {
    // Transform flat query params into nested structure (same as /names/search and /listings/search)
    const rawQuery = request.query as any;
    const transformedQuery: any = {
      q: rawQuery.q || '',
      page: parseInt(rawQuery.page || '1', 10),
      limit: parseInt(rawQuery.limit || '20', 10),
      sortBy: rawQuery.sortBy,
      sortOrder: rawQuery.sortOrder,
      filters: {},
    };

    // Parse filters from bracket notation
    for (const key in rawQuery) {
      if (key.startsWith('filters[')) {
        // Extract the filter name: filters[clubs][] -> clubs
        const match = key.match(/filters\[([^\]]+)\](\[\])?/);
        if (match) {
          const filterName = match[1];
          const isArray = match[2] === '[]';

          if (isArray) {
            // Handle array values: filters[clubs][]
            if (!transformedQuery.filters[filterName]) {
              transformedQuery.filters[filterName] = [];
            }
            const value = rawQuery[key];
            if (Array.isArray(value)) {
              // Convert to strings for clubs filter (important for numeric club names like "999")
              const values = filterName === 'clubs' ? value.map((v: any) => String(v)) : value;
              transformedQuery.filters[filterName].push(...values);
            } else {
              // Handle comma-separated values (e.g., "club1,club2" -> ["club1", "club2"])
              const stringValue = String(value);
              if (stringValue.includes(',')) {
                const splitValues = stringValue.split(',').map(v => v.trim()).filter(v => v);
                transformedQuery.filters[filterName].push(...splitValues);
              } else {
                // Convert to string for clubs filter
                const val = filterName === 'clubs' ? stringValue : value;
                transformedQuery.filters[filterName].push(val);
              }
            }
          } else {
            // Handle non-array values: filters[minPrice] or filters[clubs] (convert clubs to array)
            const value = rawQuery[key];
            // Special handling for clubs - always convert to array and ensure strings
            if (filterName === 'clubs') {
              const clubValues = Array.isArray(value) ? value : [value];
              // Convert all club values to strings (important for numeric club names like "999")
              transformedQuery.filters[filterName] = clubValues.map((c: any) => String(c));
            } else {
              transformedQuery.filters[filterName] = value;
            }
          }
        }
      }
    }

    const { q, page, limit, filters, sortBy, sortOrder } = transformedQuery;
    const { minPrice, maxPrice, minLength, maxLength, hasEmoji, hasNumbers, showListings = false, showUnlisted = false, clubs, inAnyClub, isExpired, isGracePeriod, isPremiumPeriod, expiringWithinDays, hasSales, lastSoldAfter, lastSoldBefore, minDaysSinceLastSale, maxDaysSinceLastSale, owner, includeExpired = false, contains, startsWith, endsWith, doesNotContain, doesNotStartWith, doesNotEndWith, status, listed, hasOffer, digits, letters, emoji, repeatingChars, marketplace } = filters;
    const from = (page - 1) * limit;

    // Resolve owner filter - can be either address or ENS name
    let resolvedOwnerAddress: string | null = null;
    if (owner) {
      // Check if input is an Ethereum address (0x followed by 40 hex chars)
      const isAddress = /^0x[a-fA-F0-9]{40}$/.test(owner);

      if (isAddress) {
        // It's an address, use it directly (normalize to lowercase)
        resolvedOwnerAddress = owner.toLowerCase();
        fastify.log.info(`Owner filter: address="${resolvedOwnerAddress}"`);
      } else {
        // It's an ENS name, resolve it to an address
        try {
          const resolveQuery = `
            SELECT owner_address
            FROM ens_names
            WHERE LOWER(name) = LOWER($1)
          `;
          const resolveResult = await pool.query(resolveQuery, [owner]);

          if (resolveResult.rows.length > 0 && resolveResult.rows[0].owner_address) {
            resolvedOwnerAddress = resolveResult.rows[0].owner_address.toLowerCase();
            fastify.log.info(`Owner filter: ENS name="${owner}" resolved to address="${resolvedOwnerAddress}"`);
          } else {
            fastify.log.warn(`Owner filter: ENS name="${owner}" not found in database, will return no results`);
            // Set to a non-existent address so query returns empty results
            resolvedOwnerAddress = '0x0000000000000000000000000000000000000000';
          }
        } catch (error: any) {
          fastify.log.error(`Error resolving ENS name "${owner}":`, error.message);
          // Set to a non-existent address so query returns empty results
          resolvedOwnerAddress = '0x0000000000000000000000000000000000000000';
        }
      }
    }

    fastify.log.info(`Search request: q="${q}", page=${page}, limit=${limit}, minLength=${minLength}, maxLength=${maxLength}, hasEmoji=${hasEmoji}, hasNumbers=${hasNumbers}, showListings=${showListings}, showUnlisted=${showUnlisted}, clubs=${Array.isArray(clubs) ? clubs.join(',') : clubs}, inAnyClub=${inAnyClub}, isExpired=${isExpired}, isGracePeriod=${isGracePeriod}, isPremiumPeriod=${isPremiumPeriod}, expiringWithinDays=${expiringWithinDays}, hasSales=${hasSales}, owner=${owner}, resolvedOwner=${resolvedOwnerAddress}, sortBy=${sortBy}`);

    // Try Elasticsearch first, but fall back to PostgreSQL if it fails
    // Also force PostgreSQL for sorts/filters that don't exist in Elasticsearch
    let usePostgresql = sortBy === 'watchers_count';

    // Force PostgreSQL for marketplace filter since 'source' is not in ES index
    if (marketplace && marketplace !== 'all') {
      usePostgresql = true;
      fastify.log.info(`Forcing PostgreSQL because marketplace filter="${marketplace}" (source not in Elasticsearch)`);
    }

    if (usePostgresql && sortBy === 'watchers_count') {
      fastify.log.info('Forcing PostgreSQL because sortBy=watchers_count (not available in Elasticsearch)');
    }

    // Build Elasticsearch query using shared utility
    const { must, filter } = buildESFilters({
      q,
      minPrice,
      maxPrice,
      minLength,
      maxLength,
      hasEmoji,
      hasNumbers,
      digits,
      letters,
      emoji,
      repeatingChars,
      contains,
      startsWith,
      endsWith,
      doesNotContain,
      doesNotStartWith,
      doesNotEndWith,
      listed,
      showListings,
      showUnlisted,
      hasOffer,
      clubs,
      inAnyClub,
      resolvedOwnerAddress,
      status,
      isExpired,
      isGracePeriod,
      isPremiumPeriod,
      expiringWithinDays,
      includeExpired,
      hasSales,
      lastSoldAfter,
      lastSoldBefore,
      minDaysSinceLastSale,
      maxDaysSinceLastSale,
      sortBy,
    });

    const sort = buildESSort({
      sortBy,
      sortOrder,
      q,
      resolvedOwnerAddress,
    });

    const minScore = calculateMinScore(q);

    const esQuery = {
      index: 'ens_names',
      body: {
        query: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter,
          },
        },
        min_score: minScore,
        from,
        size: limit,
        sort,
      },
    };

    // Debug logging for price sort
    if (sortBy === 'price') {
      fastify.log.info(`Price sort query - sortBy: ${sortBy}, sortOrder: ${sortOrder}, showListings: ${showListings}`);
      fastify.log.info(`ES Query: ${JSON.stringify(esQuery, null, 2)}`);
    }

    if (!usePostgresql) {
      try {
        const esResult = await es.search(esQuery);

      fastify.log.info('Elasticsearch returned results');

      // Extract ENS names from Elasticsearch results
      const allNames = esResult.hits.hits.map((hit: any) => hit._source.name);

      // Filter out placeholder names (token-### and [hash].eth)
      // Note: Numeric names like 0000.eth are valid ENS names (999 club, 10k club, etc.)
      const ensNames = allNames.filter((name: string) => {
        return name && !name.startsWith('token-') && !name.startsWith('[');
      });

      fastify.log.info(`ES returned ${allNames.length} names, ${ensNames.length} after filtering placeholders. First 5: ${JSON.stringify(ensNames.slice(0, 5))}`);

      if (ensNames.length === 0) {
        fastify.log.info('No ES results found');
        return reply.send({
          success: true,
          data: {
            results: [],
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: 0,
              totalPages: 0,
              hasNext: false,
              hasPrev: false,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        });
      }

      // Get user ID if authenticated
      const userId = request.user ? parseInt(request.user.sub) : undefined;

      // Build search results using shared utility
      const results = await buildSearchResults(ensNames, userId);

      fastify.log.info(`buildSearchResults returned ${results.length} results from ${ensNames.length} names`);

      // If Elasticsearch returned names but PostgreSQL has none of them,
      // it means ES has stale data. Fall back to PostgreSQL.
      if (results.length === 0 && ensNames.length > 0) {
        fastify.log.warn(`Elasticsearch returned ${ensNames.length} names but PostgreSQL has none of them. Falling back to PostgreSQL for this query.`);
        usePostgresql = true;
      } else {
        const currentPage = parseInt(page);
        const pageLimit = parseInt(limit);
        const total = typeof esResult.hits.total === 'object' ? esResult.hits.total.value : (esResult.hits.total || 0);
        const totalPages = Math.ceil(total / pageLimit);

        fastify.log.info(`ES search pagination: page=${currentPage}, total=${total}, totalPages=${totalPages}, hasNext=${currentPage < totalPages}`);

        const response: APIResponse<{
          results: any[];
          pagination: any;
        }> = {
          success: true,
          data: {
            results,
            pagination: {
              page: currentPage,
              limit: pageLimit,
              total,
              totalPages,
              hasNext: currentPage < totalPages,
              hasPrev: currentPage > 1,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        };

        return reply.send(response);
      }
      } catch (error: any) {
        fastify.log.warn('Elasticsearch search failed, falling back to PostgreSQL:', error.message);
        usePostgresql = true;
      }
    }

    if (usePostgresql) {

      // Fallback to PostgreSQL-based search
      // Unified listed filter: true = only listed, false = only unlisted
      // Legacy showListings/showUnlisted kept for backward compatibility
      // Marketplace filter implies listingsOnly since it filters by listing source
      const hasMarketplaceFilter = marketplace && marketplace !== 'all';
      const listingsOnly = listed === 'true' || listed === true || showListings === true || showListings === 'true' || hasMarketplaceFilter;
      const unlistedOnly = listed === 'false' || listed === false || showUnlisted === true || showUnlisted === 'true';
      let whereConditions: string[] = [];
      let params: any[] = [];
      let paramCount = 1;

      // Skip the default "exclude expired names" filter if user is explicitly filtering by status
      const pgHasExplicitExpirationFilter = status !== undefined && status !== 'all';
      if (includeExpired !== true && includeExpired !== 'true' && !pgHasExplicitExpirationFilter) {
        whereConditions.push(`(en.expiry_date IS NULL OR en.expiry_date + INTERVAL '90 days' > NOW())`);
      }

      // Exclude subnames - only show *.eth pattern (not *.*.eth or deeper)
      whereConditions.push(`en.name NOT LIKE '%.%.eth'`);

      // Exclude placeholder names (token-* and [hash].eth)
      whereConditions.push(`en.name NOT LIKE 'token-%'`);
      whereConditions.push(`en.name NOT LIKE '[%'`);

      // Filter by listing status
      if (listingsOnly) {
        whereConditions.push(`l.status = $${paramCount}`);
        params.push('active');
        paramCount++;
      }

      // Marketplace filter - filter by listing source
      // Note: marketplace filter now implies listingsOnly (set above), so l.status = 'active' is already handled
      if (marketplace === 'grails') {
        whereConditions.push(`l.source = $${paramCount}`);
        params.push('grails');
        paramCount++;
      } else if (marketplace === 'opensea') {
        whereConditions.push(`l.source = $${paramCount}`);
        params.push('opensea');
        paramCount++;
      }

      if (unlistedOnly) {
        // Only show names that don't have an active listing
        whereConditions.push(`(l.id IS NULL OR l.status != 'active')`);
      }

      fastify.log.info(`Using PostgreSQL fallback, query="${q}", showListings=${listingsOnly}, showUnlisted=${unlistedOnly}, sortBy=${sortBy}, sortOrder=${sortOrder}`);

      // Add unified status filter
      if (status && status !== 'all') {
        if (status === 'registered') {
          // Registered: expiry_date > now
          whereConditions.push(`en.expiry_date > NOW()`);
        } else if (status === 'grace') {
          // Grace period: expired within last 90 days
          whereConditions.push(`en.expiry_date <= NOW() AND en.expiry_date > NOW() - INTERVAL '90 days'`);
        } else if (status === 'premium') {
          // Premium period: expired 90-111 days ago
          whereConditions.push(`en.expiry_date <= NOW() - INTERVAL '90 days' AND en.expiry_date > NOW() - INTERVAL '111 days'`);
        } else if (status === 'available') {
          // Available: expired more than 111 days ago
          whereConditions.push(`en.expiry_date <= NOW() - INTERVAL '111 days'`);
        }
      }

      // Add name search condition
      if (q && q.trim()) {
        const searchPattern = `%${q.toLowerCase()}%`;
        whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
        params.push(searchPattern);
        paramCount++;
        fastify.log.info(`Added name search condition: ${searchPattern}`);
      }

      // Add price filters (only for listings)
      if (minPrice && listingsOnly) {
        whereConditions.push(`CAST(l.price_wei AS NUMERIC) >= $${paramCount}`);
        params.push(minPrice);
        paramCount++;
      }

      if (maxPrice && listingsOnly) {
        whereConditions.push(`CAST(l.price_wei AS NUMERIC) <= $${paramCount}`);
        params.push(maxPrice);
        paramCount++;
      }

      // Add length filters
      if (minLength) {
        whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) >= $${paramCount}`);
        params.push(parseInt(minLength));
        paramCount++;
      }

      if (maxLength) {
        whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) <= $${paramCount}`);
        params.push(parseInt(maxLength));
        paramCount++;
      }

      // Add contains filter - exact substring match
      if (contains) {
        whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
        params.push(`%${contains.toLowerCase()}%`);
        paramCount++;
      }

      // Add startsWith filter - prefix match
      if (startsWith) {
        whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
        params.push(`${startsWith.toLowerCase()}%`);
        paramCount++;
      }

      // Add endsWith filter - suffix match (before .eth)
      if (endsWith) {
        whereConditions.push(`LOWER(en.name) LIKE $${paramCount}`);
        params.push(`%${endsWith.toLowerCase()}.eth`);
        paramCount++;
      }

      // Add doesNotContain filter - exclude names containing substring
      if (doesNotContain) {
        whereConditions.push(`LOWER(en.name) NOT LIKE $${paramCount}`);
        params.push(`%${doesNotContain.toLowerCase()}%`);
        paramCount++;
      }

      // Add doesNotStartWith filter - exclude names starting with prefix
      if (doesNotStartWith) {
        whereConditions.push(`LOWER(en.name) NOT LIKE $${paramCount}`);
        params.push(`${doesNotStartWith.toLowerCase()}%`);
        paramCount++;
      }

      // Add doesNotEndWith filter - exclude names ending with suffix (before .eth)
      if (doesNotEndWith) {
        whereConditions.push(`LOWER(en.name) NOT LIKE $${paramCount}`);
        params.push(`%${doesNotEndWith.toLowerCase()}.eth`);
        paramCount++;
      }

      // Add hasOffer filter
      if (hasOffer === 'true' || hasOffer === true) {
        whereConditions.push(`en.highest_offer_wei IS NOT NULL AND CAST(en.highest_offer_wei AS NUMERIC) > 0`);
      } else if (hasOffer === 'false' || hasOffer === false) {
        whereConditions.push(`(en.highest_offer_wei IS NULL OR CAST(en.highest_offer_wei AS NUMERIC) <= 0)`);
      }

      // Add emoji filter
      if (hasEmoji !== undefined) {
        whereConditions.push(`en.has_emoji = $${paramCount}`);
        params.push(hasEmoji === 'true' || hasEmoji === true);
        paramCount++;
      }

      // Add numbers filter
      if (hasNumbers !== undefined) {
        whereConditions.push(`en.has_numbers = $${paramCount}`);
        params.push(hasNumbers === 'true' || hasNumbers === true);
        paramCount++;
      }

      // Tri-state digits filter: allowed (default), exclude, only
      if (digits === 'exclude') {
        whereConditions.push(`en.has_numbers = false`);
      } else if (digits === 'only') {
        // Only digits (0-9) - regex check
        whereConditions.push(`REPLACE(en.name, '.eth', '') ~ '^[0-9]+$'`);
      }

      // Tri-state letters filter: allowed (default), exclude, only
      if (letters === 'exclude') {
        // No letters allowed
        whereConditions.push(`REPLACE(en.name, '.eth', '') !~ '[a-zA-Z]'`);
      } else if (letters === 'only') {
        // Only letters (a-z)
        whereConditions.push(`REPLACE(en.name, '.eth', '') ~ '^[a-zA-Z]+$'`);
      }

      // Tri-state emoji filter: allowed (default), exclude, only
      if (emoji === 'exclude') {
        whereConditions.push(`en.has_emoji = false`);
      } else if (emoji === 'only') {
        // Only emoji - has emoji AND no letters AND no digits
        whereConditions.push(`en.has_emoji = true`);
        whereConditions.push(`REPLACE(en.name, '.eth', '') !~ '[a-zA-Z0-9]'`);
      }

      // Tri-state repeatingChars filter: allowed (default), exclude, only
      // "only" means ALL characters are the same (e.g., "99999", "aaaa")
      // "exclude" means NOT all characters are the same
      if (repeatingChars === 'exclude') {
        // Exclude names where all characters are the same
        whereConditions.push(`REPLACE(en.name, '.eth', '') !~ '^(.)\\1*$'`);
      } else if (repeatingChars === 'only') {
        // Only names where all characters are the same
        whereConditions.push(`REPLACE(en.name, '.eth', '') ~ '^(.)\\1*$'`);
      }

      // Add owner filter
      if (resolvedOwnerAddress) {
        whereConditions.push(`LOWER(en.owner_address) = $${paramCount}`);
        params.push(resolvedOwnerAddress);
        paramCount++;
      }

      const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

      // Build ORDER BY clause based on sortBy parameter
      let orderByClause = '';
      const order = sortOrder || 'desc';
      const sqlOrder = order.toUpperCase();

      if (sortBy === 'last_sale_price') {
        // Sort by USD value for proper cross-currency comparison
        orderByClause = `ORDER BY en.last_sale_price_usd ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'watchers_count') {
        // Sort by watchers count - use alias from SELECT clause to avoid DISTINCT conflict
        orderByClause = `ORDER BY sort_value ${sqlOrder}`;
      } else if (sortBy === 'price') {
        // Sort by listing price using the subquery alias
        // When not filtering, names without listings will have NULL and appear last
        orderByClause = `ORDER BY sort_value ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'offer') {
        // Sort by highest offer price using the aliased cast column
        orderByClause = `ORDER BY offer_sort ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'expiry_date') {
        orderByClause = `ORDER BY en.expiry_date ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'registration_date') {
        orderByClause = `ORDER BY en.registration_date ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'last_sale_date') {
        orderByClause = `ORDER BY en.last_sale_date ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'character_count') {
        // Use alias from SELECT clause to avoid DISTINCT conflict
        orderByClause = `ORDER BY sort_value ${sqlOrder}`;
      } else if (sortBy === 'alphabetical') {
        // Sort by name alphabetically
        orderByClause = `ORDER BY en.name ${sqlOrder}`;
      } else {
        // Default sorting
        orderByClause = listingsOnly ? 'ORDER BY l.created_at DESC' : 'ORDER BY en.name ASC';
      }

      // Build queries based on showListings - get the ENS names
      const countQuery = listingsOnly ? `
        SELECT COUNT(DISTINCT en.id)
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE ${whereClause}
      ` : `
        SELECT COUNT(*)
        FROM ens_names en
        WHERE ${whereClause}
      `;

      // Build SELECT clause - need to include sort column when using DISTINCT
      // PostgreSQL requires ORDER BY columns to be in SELECT list when using DISTINCT
      let selectClause = 'DISTINCT en.name';
      if (sortBy === 'watchers_count') {
        selectClause = 'en.name, (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as sort_value';
      } else if (sortBy === 'last_sale_price') {
        selectClause = 'DISTINCT en.name, en.last_sale_price_usd';
      } else if (sortBy === 'expiry_date') {
        selectClause = 'DISTINCT en.name, en.expiry_date';
      } else if (sortBy === 'registration_date') {
        selectClause = 'DISTINCT en.name, en.registration_date';
      } else if (sortBy === 'last_sale_date') {
        selectClause = 'DISTINCT en.name, en.last_sale_date';
      } else if (sortBy === 'character_count') {
        selectClause = 'DISTINCT en.name, LENGTH(REPLACE(en.name, \'.eth\', \'\')) as sort_value';
      } else if (sortBy === 'price') {
        // Use a subquery to get the max price for each name to avoid DISTINCT issues
        selectClause = 'en.name, (SELECT MAX(CAST(price_wei AS NUMERIC)) FROM listings WHERE ens_name_id = en.id AND status = \'active\') as sort_value';
      } else if (sortBy === 'offer') {
        selectClause = 'DISTINCT en.name, CAST(en.highest_offer_wei AS NUMERIC) as offer_sort';
      } else if (listingsOnly && !sortBy) {
        // Default sort for listings-only queries is l.created_at, must include it in SELECT
        selectClause = 'DISTINCT en.name, l.created_at';
      }

      const dataQuery = listingsOnly ? `
        SELECT ${selectClause}
        FROM listings l
        JOIN ens_names en ON l.ens_name_id = en.id
        WHERE ${whereClause}
        ${orderByClause}
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      ` : `
        SELECT ${selectClause}
        FROM ens_names en
        ${sortBy === 'price' ? '' : 'LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = \'active\''}
        WHERE ${whereClause}
        ${orderByClause}
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `;

      params.push(limit, from);

      try {
        const [countResult, dataResult] = await Promise.all([
          pool.query(countQuery, params.slice(0, -2)),
          pool.query(dataQuery, params),
        ]);

        const total = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(total / limit);
        const currentPage = parseInt(page);

        // Get user ID if authenticated
        const userId = request.user ? parseInt(request.user.sub) : undefined;

        // Extract names and build results using shared utility
        const ensNames = dataResult.rows.map((row: any) => row.name);
        const results = await buildSearchResults(ensNames, userId);

        fastify.log.info(`PostgreSQL returned ${dataResult.rows.length} rows. First 5 names: ${JSON.stringify(ensNames.slice(0, 5))}`);
        if (sortBy === 'price') {
          const sortValues = dataResult.rows.slice(0, 5).map((row: any) => row.sort_value || row.price_wei);
          fastify.log.info(`First 5 sort values for price: ${JSON.stringify(sortValues)}`);
        }
        fastify.log.info(`Pagination: page=${currentPage}, limit=${limit}, total=${total}, totalPages=${totalPages}, hasNext=${currentPage < totalPages}`);

        return reply.send({
          success: true,
          data: {
            results,
            pagination: {
              page: currentPage,
              limit: parseInt(limit),
              total,
              totalPages,
              hasNext: currentPage < totalPages,
              hasPrev: currentPage > 1,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        });
      } catch (pgError: any) {
        fastify.log.error({ error: pgError, query: dataQuery, params }, 'PostgreSQL fallback search also failed');
        return reply.status(500).send({
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: 'Search service temporarily unavailable',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  });

  // Bulk exact search endpoint - searches for exact matches on multiple terms
  // POST /api/v1/search/bulk-exact
  fastify.post('/bulk', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      // Validate request body
      const parseResult = BulkExactSearchSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: parseResult.error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { terms, page, limit } = parseResult.data;
      const total = terms.length;
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;

      // Paginate the input terms
      const paginatedTerms = terms.slice(offset, offset + limit);

      fastify.log.info(`Bulk exact search request: ${total} total terms, page ${page}/${totalPages}, showing ${paginatedTerms.length} terms`);

      // Normalize terms - add .eth suffix if not present for exact matching
      const normalizedTerms = paginatedTerms.map(term => {
        const lower = term.toLowerCase().trim();
        return lower.endsWith('.eth') ? lower : `${lower}.eth`;
      });

      // Build Elasticsearch query for exact keyword matches
      const esQuery = {
        index: 'ens_names',
        body: {
          query: {
            bool: {
              filter: [
                // Exact match on name.keyword for each term
                {
                  terms: {
                    'name.keyword': normalizedTerms,
                  },
                },
                // Exclude placeholder names
                {
                  bool: {
                    must_not: [
                      { prefix: { 'name.keyword': 'token-' } },
                      { prefix: { 'name.keyword': '[' } },
                    ],
                  },
                },
              ],
            },
          },
          size: normalizedTerms.length, // We want at most one result per term
        },
      };

      let foundNames: string[] = [];

      try {
        const esResult = await es.search(esQuery);
        foundNames = esResult.hits.hits.map((hit: any) => hit._source.name.toLowerCase());
        fastify.log.info(`Elasticsearch found ${foundNames.length} exact matches`);
      } catch (esError: any) {
        fastify.log.warn('Elasticsearch bulk exact search failed, falling back to PostgreSQL:', esError.message);

        // Fallback to PostgreSQL
        const placeholders = normalizedTerms.map((_, i) => `$${i + 1}`).join(',');
        const pgQuery = `
          SELECT LOWER(name) as name
          FROM ens_names
          WHERE LOWER(name) IN (${placeholders})
            AND name NOT LIKE 'token-%'
            AND name NOT LIKE '[%'
        `;
        const pgResult = await pool.query(pgQuery, normalizedTerms);
        foundNames = pgResult.rows.map((row: any) => row.name);
        fastify.log.info(`PostgreSQL found ${foundNames.length} exact matches`);
      }

      // Create a set for quick lookup
      const foundNamesSet = new Set(foundNames);

      // Get user ID if authenticated
      const userId = request.user ? parseInt(request.user.sub) : undefined;

      // Build enriched results for found names
      const enrichedResults = foundNames.length > 0
        ? await buildSearchResults(foundNames, userId)
        : [];

      // Create a map of name -> enriched result for quick lookup
      const resultsMap = new Map<string, SearchResult>();
      for (const result of enrichedResults) {
        resultsMap.set(result.name.toLowerCase(), result);
      }

      // Build response array preserving original term order
      // Returns standard SearchResult format - placeholder objects for not-found terms
      const results: SearchResult[] = normalizedTerms.map((normalizedTerm, index) => {
        const originalTerm = paginatedTerms[index];
        const found = foundNamesSet.has(normalizedTerm);

        if (found) {
          const data = resultsMap.get(normalizedTerm);
          return data!;
        } else {
          return createNotFoundResult(originalTerm);
        }
      });

      const response: APIResponse<{ results: SearchResult[]; pagination: any }> = {
        success: true,
        data: {
          results,
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error({ error }, 'Bulk exact search failed');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'SEARCH_ERROR',
          message: 'Bulk exact search failed',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
