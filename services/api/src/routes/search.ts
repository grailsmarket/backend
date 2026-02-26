import type { FastifyInstance } from 'fastify';
import { getPostgresPool, getElasticsearchClient, type APIResponse } from '../../../shared/src';
import { buildSearchResults, type SearchResult } from '../utils/response-builder';
import { buildESFilters, buildESSort, calculateMinScore, buildESQuery } from '../utils/elasticsearch-filters';
import { optionalAuth } from '../middleware/auth';
import { fetchExportData, exportRowsToCSV, CSV_HEADERS, MAX_EXPORT_ROWS } from '../utils/csv-export';
import { z } from 'zod';

// Schema for bulk exact search request
const BulkExactSearchSchema = z.object({
  terms: z.array(z.string().min(1)).min(1).max(10000),
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// Helper to properly parse boolean strings (unlike z.coerce.boolean which treats "false" as true)
const booleanString = z.union([z.boolean(), z.string()]).optional();

// Schema for bulk search with filters request
const BulkFiltersSearchSchema = z.object({
  // Bulk search terms (required)
  terms: z.array(z.string().min(1)).min(1).max(10000),

  // Pagination for final filtered results
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(100).optional().default(20),

  // Sorting
  sortBy: z.enum([
    'price', 'expiry_date', 'registration_date', 'creation_date', 'last_sale_date',
    'last_sale_price', 'character_count', 'watchers_count', 'alphabetical', 'offer',
    'listing_date', 'listing_expiry', 'google_monthly_searches', 'google_avg_cpc'
  ]).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),

  // Filters object (same structure as GET /search filters parameter)
  filters: z.object({
    // Price filters
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),
    minOffer: z.string().optional(),
    maxOffer: z.string().optional(),

    // Length filters
    minLength: z.coerce.number().optional(),
    maxLength: z.coerce.number().optional(),

    // Count filters (require PostgreSQL - not in ES index)
    minWatchersCount: z.coerce.number().optional(),
    maxWatchersCount: z.coerce.number().optional(),
    minViewCount: z.coerce.number().optional(),
    maxViewCount: z.coerce.number().optional(),
    minClubsCount: z.coerce.number().optional(),
    maxClubsCount: z.coerce.number().optional(),

    // Legacy character filters
    hasNumbers: booleanString,
    hasEmoji: booleanString,

    // Tri-state character filters
    digits: z.enum(['include', 'exclude', 'only']).optional(),
    letters: z.enum(['include', 'exclude', 'only']).optional(),
    emoji: z.enum(['include', 'exclude', 'only']).optional(),
    repeatingChars: z.enum(['include', 'exclude', 'only']).optional(),

    // String pattern filters
    contains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    doesNotContain: z.string().optional(),
    doesNotStartWith: z.string().optional(),
    doesNotEndWith: z.string().optional(),

    // Listing/market filters
    listed: booleanString,
    hasOffer: booleanString,
    showListings: booleanString,
    showUnlisted: booleanString,
    marketplace: z.enum(['grails', 'opensea', 'all']).optional(),

    // Club filters
    clubs: z.array(z.string()).optional(),
    excludeClubs: z.array(z.string()).optional(),
    inAnyClub: booleanString,

    // Unified status filter
    status: z.union([
      z.enum(['registered', 'grace', 'premium', 'available', 'all']),
      z.array(z.enum(['registered', 'grace', 'premium', 'available', 'all']))
    ]).optional(),

    // Legacy expiration filters
    isExpired: booleanString,
    isGracePeriod: booleanString,
    isPremiumPeriod: booleanString,
    expiringWithinDays: z.coerce.number().optional(),
    includeExpired: booleanString,

    // Sale history filters
    hasSales: booleanString,
    lastSoldAfter: z.string().optional(),
    lastSoldBefore: z.string().optional(),
    minDaysSinceLastSale: z.coerce.number().optional(),
    maxDaysSinceLastSale: z.coerce.number().optional(),

    // Creation date filters
    minCreationDate: z.string().optional(),
    maxCreationDate: z.string().optional(),

    // Owner filter
    owner: z.string().optional(),
  }).optional(),
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
    creation_date: null,
    last_sale_date: null,
    metadata: {},
    metadata_updated_at: null,
    clubs: [],
    club_ranks: null,
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
    watchlist_record_id: null,
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
  // Set export=true to download results as CSV (requires authentication)
  fastify.get('/', { preHandler: optionalAuth }, async (request, reply) => {
    const rawQuery = request.query as any;
    const isExport = rawQuery.export === 'true' || rawQuery.export === true;

    // Export mode requires authentication
    if (isExport) {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required for export',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }
    }

    // Transform flat query params into nested structure (same as /names/search and /listings/search)
    // For export mode, allow higher limit (up to 10k) and always start at page 1
    const requestedLimit = parseInt(rawQuery.limit || '20', 10);
    const transformedQuery: any = {
      q: rawQuery.q || '',
      page: isExport ? 1 : parseInt(rawQuery.page || '1', 10),
      limit: isExport ? Math.min(requestedLimit || MAX_EXPORT_ROWS, MAX_EXPORT_ROWS) : Math.min(requestedLimit, 100),
      sortBy: rawQuery.sortBy,
      sortOrder: rawQuery.sortOrder,
      filters: {},
    };
    const filename = rawQuery.filename || 'ens-export';

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
            } else if (filterName === 'status') {
              // Special handling for status - support comma-separated values
              const stringValue = String(value);
              if (stringValue.includes(',')) {
                transformedQuery.filters[filterName] = stringValue.split(',').map(v => v.trim()).filter(v => v);
              } else {
                transformedQuery.filters[filterName] = value;
              }
            } else {
              transformedQuery.filters[filterName] = value;
            }
          }
        }
      }
    }

    const { q, page, limit, filters, sortBy, sortOrder } = transformedQuery;
    const { minPrice, maxPrice, minOffer, maxOffer, minLength, maxLength, minWatchersCount, maxWatchersCount, minViewCount, maxViewCount, minClubsCount, maxClubsCount, hasEmoji, hasNumbers, showListings = false, showUnlisted = false, clubs, excludeClubs, inAnyClub, isExpired, isGracePeriod, isPremiumPeriod, expiringWithinDays, hasSales, lastSoldAfter, lastSoldBefore, minDaysSinceLastSale, maxDaysSinceLastSale, minCreationDate, maxCreationDate, owner, includeExpired = false, contains, startsWith, endsWith, doesNotContain, doesNotStartWith, doesNotEndWith, status, listed, hasOffer, digits, letters, emoji, repeatingChars, marketplace, uniqueSeller } = filters;
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

    fastify.log.info(`Search request: q="${q}", page=${page}, limit=${limit}, minLength=${minLength}, maxLength=${maxLength}, hasEmoji=${hasEmoji}, hasNumbers=${hasNumbers}, showListings=${showListings}, showUnlisted=${showUnlisted}, clubs=${Array.isArray(clubs) ? clubs.join(',') : clubs}, inAnyClub=${inAnyClub}, isExpired=${isExpired}, isGracePeriod=${isGracePeriod}, isPremiumPeriod=${isPremiumPeriod}, expiringWithinDays=${expiringWithinDays}, hasSales=${hasSales}, owner=${owner}, resolvedOwner=${resolvedOwnerAddress}, sortBy=${sortBy}, uniqueSeller=${uniqueSeller}`);

    // Try Elasticsearch first, but fall back to PostgreSQL if it fails
    // Also force PostgreSQL for sorts/filters that don't exist in Elasticsearch
    let usePostgresql = sortBy === 'watchers_count' || sortBy === 'view_count' || sortBy === 'clubs_count';

    // Force PostgreSQL for count filters since these fields are not in ES index
    if (minWatchersCount !== undefined || maxWatchersCount !== undefined ||
        minViewCount !== undefined || maxViewCount !== undefined ||
        minClubsCount !== undefined || maxClubsCount !== undefined) {
      usePostgresql = true;
      fastify.log.info('Forcing PostgreSQL because count filters are used (not available in Elasticsearch)');
    }

    // Force PostgreSQL for marketplace filter since 'source' is not in ES index
    if (marketplace && marketplace !== 'all') {
      usePostgresql = true;
      fastify.log.info(`Forcing PostgreSQL because marketplace filter="${marketplace}" (source not in Elasticsearch)`);
    }

    // Force PostgreSQL for uniqueSeller filter - requires CTE with ROW_NUMBER()
    const uniqueSellerEnabled = uniqueSeller === 'true' || uniqueSeller === true;
    if (uniqueSellerEnabled) {
      usePostgresql = true;
      fastify.log.info('Forcing PostgreSQL because uniqueSeller filter is enabled');
    }

    // Validate and force PostgreSQL for ranking sort
    if (sortBy === 'ranking') {
      const isValidClubForRanking = clubs && Array.isArray(clubs) && clubs.length === 1
        && !clubs.includes('any') && !clubs.includes('none');

      if (!isValidClubForRanking) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'sortBy=ranking requires exactly one club filter',
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      usePostgresql = true;
      fastify.log.info('Forcing PostgreSQL because sortBy=ranking (requires club_memberships JOIN)');
    }

    if (usePostgresql && sortBy === 'watchers_count') {
      fastify.log.info('Forcing PostgreSQL because sortBy=watchers_count (not available in Elasticsearch)');
    }

    if (usePostgresql && sortBy === 'view_count') {
      fastify.log.info('Forcing PostgreSQL because sortBy=view_count (not available in Elasticsearch)');
    }

    if (usePostgresql && sortBy === 'clubs_count') {
      fastify.log.info('Forcing PostgreSQL because sortBy=clubs_count (not available in Elasticsearch)');
    }

    // Build Elasticsearch query using shared utility
    const { must, filter } = buildESFilters({
      q,
      minPrice,
      maxPrice,
      minOffer,
      maxOffer,
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
      excludeClubs,
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
      minCreationDate,
      maxCreationDate,
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

        // Handle export mode - return empty CSV with headers
        if (isExport) {
          reply.header('Content-Type', 'text/csv');
          reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
          return reply.send(CSV_HEADERS.join(',') + '\n');
        }

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

      // Handle export mode - use fast lightweight query instead of buildSearchResults
      if (isExport) {
        const exportRows = await fetchExportData(pool, ensNames);
        const csvContent = await exportRowsToCSV(exportRows);
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return reply.send(csvContent);
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

      // Determine when to apply the "exclude premium/available" filter (PostgreSQL path)
      // This filter excludes names expired more than 90 days ago (premium and available statuses)
      //
      // By default, show ALL statuses (registered, grace, premium, available)
      // Only apply the exclusion filter when:
      // 1. owner filter is set (Profile Names tab should only show registered/grace)
      // 2. sortBy=expiry_date (sorting by expiry doesn't make sense for expired names)
      // 3. sortBy=price (expired names can't have active listings)
      //
      // Skip the filter when:
      // - includeExpired is explicitly true
      // - explicit expiration/status filters are set (user knows what they want)
      const pgHasExplicitStatusFilter = status !== undefined &&
        (Array.isArray(status) ? status.length > 0 && !status.includes('all') : status !== 'all');
      const pgHasExplicitExpirationFilter = pgHasExplicitStatusFilter;

      // Only apply the default "exclude premium/available" filter for specific cases
      const pgShouldExcludePremiumAvailable =
        includeExpired !== true &&
        includeExpired !== 'true' &&
        !pgHasExplicitExpirationFilter &&
        (resolvedOwnerAddress || sortBy === 'expiry_date' || sortBy === 'price' || sortBy === 'listing_date' || sortBy === 'listing_expiry');

      if (pgShouldExcludePremiumAvailable) {
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

      // Add unified status filter - supports single value or array (OR logic for multiple)
      if (status && status !== 'all') {
        const statuses = Array.isArray(status) ? status.filter((s: string) => s !== 'all') : [status];

        // Helper to build SQL condition for a single status
        const buildStatusCondition = (s: string): string | null => {
          switch (s) {
            case 'registered':
              return `en.expiry_date > NOW()`;
            case 'grace':
              return `(en.expiry_date <= NOW() AND en.expiry_date > NOW() - INTERVAL '90 days')`;
            case 'premium':
              return `(en.expiry_date <= NOW() - INTERVAL '90 days' AND en.expiry_date > NOW() - INTERVAL '111 days')`;
            case 'available':
              return `en.expiry_date <= NOW() - INTERVAL '111 days'`;
            default:
              return null;
          }
        };

        if (statuses.length === 1) {
          // Single status
          const condition = buildStatusCondition(statuses[0]);
          if (condition) {
            whereConditions.push(condition);
          }
        } else if (statuses.length > 1) {
          // Multiple statuses - use OR logic
          const conditions = statuses
            .map(buildStatusCondition)
            .filter((c): c is string => c !== null);

          if (conditions.length > 0) {
            whereConditions.push(`(${conditions.join(' OR ')})`);
          }
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

      // Add watchers count filters
      if (minWatchersCount !== undefined) {
        whereConditions.push(`(SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) >= $${paramCount}`);
        params.push(parseInt(String(minWatchersCount)));
        paramCount++;
      }
      if (maxWatchersCount !== undefined) {
        whereConditions.push(`(SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) <= $${paramCount}`);
        params.push(parseInt(String(maxWatchersCount)));
        paramCount++;
      }

      // Add view count filters
      if (minViewCount !== undefined) {
        whereConditions.push(`COALESCE(en.view_count, 0) >= $${paramCount}`);
        params.push(parseInt(String(minViewCount)));
        paramCount++;
      }
      if (maxViewCount !== undefined) {
        whereConditions.push(`COALESCE(en.view_count, 0) <= $${paramCount}`);
        params.push(parseInt(String(maxViewCount)));
        paramCount++;
      }

      // Add clubs count filters
      if (minClubsCount !== undefined) {
        whereConditions.push(`COALESCE(array_length(en.clubs, 1), 0) >= $${paramCount}`);
        params.push(parseInt(String(minClubsCount)));
        paramCount++;
      }
      if (maxClubsCount !== undefined) {
        whereConditions.push(`COALESCE(array_length(en.clubs, 1), 0) <= $${paramCount}`);
        params.push(parseInt(String(maxClubsCount)));
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

      // Add offer amount filters
      if (minOffer) {
        whereConditions.push(`CAST(en.highest_offer_wei AS NUMERIC) >= $${paramCount}`);
        params.push(minOffer);
        paramCount++;
      }

      if (maxOffer) {
        whereConditions.push(`CAST(en.highest_offer_wei AS NUMERIC) <= $${paramCount}`);
        params.push(maxOffer);
        paramCount++;
      }

      // Add clubs filter - handle special values 'none' and 'any'
      if (clubs && clubs.length > 0) {
        if (clubs.includes('none')) {
          // 'none' means names NOT in any club
          whereConditions.push(`(en.clubs IS NULL OR array_length(en.clubs, 1) = 0)`);
        } else if (clubs.includes('any')) {
          // 'any' means names in at least one club
          whereConditions.push(`en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0`);
        } else {
          // Regular club filter - match any of the specified clubs
          whereConditions.push(`en.clubs && $${paramCount}::text[]`);
          params.push(clubs);
          paramCount++;
        }
      }

      // Exclude clubs filter - can be used standalone or with clubs='any'
      // Excludes names that are in ANY of the specified clubs
      if (excludeClubs && excludeClubs.length > 0) {
        whereConditions.push(`(en.clubs IS NULL OR NOT (en.clubs && $${paramCount}::text[]))`);
        params.push(excludeClubs);
        paramCount++;
      }

      // Add inAnyClub filter
      if (inAnyClub !== undefined) {
        const wantInClub = inAnyClub === 'true' || inAnyClub === true;
        if (wantInClub) {
          whereConditions.push(`en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0`);
        } else {
          whereConditions.push(`(en.clubs IS NULL OR array_length(en.clubs, 1) = 0)`);
        }
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

      // Add creation date filters
      if (minCreationDate) {
        whereConditions.push(`en.creation_date >= $${paramCount}`);
        params.push(minCreationDate);
        paramCount++;
      }
      if (maxCreationDate) {
        whereConditions.push(`en.creation_date <= $${paramCount}`);
        params.push(maxCreationDate);
        paramCount++;
      }

      // Add owner filter
      if (resolvedOwnerAddress) {
        whereConditions.push(`LOWER(en.owner_address) = $${paramCount}`);
        params.push(resolvedOwnerAddress);
        paramCount++;
      }

      const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

      // Push club name param for ranking JOIN
      let rankingParamIndex: number | null = null;
      if (sortBy === 'ranking') {
        rankingParamIndex = paramCount;
        params.push(clubs[0]);
        paramCount++;
      }

      // Build ORDER BY clause based on sortBy parameter
      let orderByClause = '';
      const order = sortOrder || (sortBy === 'ranking' ? 'asc' : 'desc');
      const sqlOrder = order.toUpperCase();

      if (sortBy === 'last_sale_price') {
        // Sort by USD value for proper cross-currency comparison
        orderByClause = `ORDER BY en.last_sale_price_usd ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'watchers_count') {
        // Sort by watchers count - use alias from SELECT clause to avoid DISTINCT conflict
        orderByClause = `ORDER BY sort_value ${sqlOrder}`;
      } else if (sortBy === 'view_count') {
        // Sort by view count - use alias from SELECT clause to avoid DISTINCT conflict
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
      } else if (sortBy === 'creation_date') {
        orderByClause = `ORDER BY en.creation_date ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'last_sale_date') {
        orderByClause = `ORDER BY en.last_sale_date ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'character_count') {
        // Use alias from SELECT clause to avoid DISTINCT conflict
        orderByClause = `ORDER BY sort_value ${sqlOrder}`;
      } else if (sortBy === 'clubs_count') {
        // Sort by number of clubs with alphabetical tie-breaker (COLLATE "C" for consistent ASCII ordering)
        orderByClause = `ORDER BY sort_value ${sqlOrder}, name_sort ASC`;
      } else if (sortBy === 'listing_date') {
        orderByClause = `ORDER BY l.created_at ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'listing_expiry') {
        orderByClause = `ORDER BY l.expires_at ${sqlOrder} NULLS LAST`;
      } else if (sortBy === 'alphabetical') {
        // Sort by name alphabetically
        orderByClause = `ORDER BY en.name ${sqlOrder}`;
      } else if (sortBy === 'ranking') {
        orderByClause = `ORDER BY sort_value ${sqlOrder} NULLS LAST`;
      } else {
        // Default sorting
        orderByClause = listingsOnly ? 'ORDER BY l.created_at DESC' : 'ORDER BY en.name ASC';
      }

      // Build queries based on showListings - get the ENS names
      // When uniqueSeller is enabled, count unique sellers instead of unique names
      let countQuery: string;
      const rankingJoin = sortBy === 'ranking' ? `LEFT JOIN club_memberships cm_rank ON cm_rank.ens_name = en.name AND cm_rank.club_name = $${rankingParamIndex}` : '';
      if (uniqueSellerEnabled && listingsOnly) {
        countQuery = `
          SELECT COUNT(DISTINCT l.seller_address)
          FROM listings l
          JOIN ens_names en ON l.ens_name_id = en.id
          ${rankingJoin}
          WHERE ${whereClause}
        `;
      } else if (listingsOnly) {
        countQuery = `
          SELECT COUNT(DISTINCT en.id)
          FROM listings l
          JOIN ens_names en ON l.ens_name_id = en.id
          ${rankingJoin}
          WHERE ${whereClause}
        `;
      } else {
        countQuery = `
          SELECT COUNT(*)
          FROM ens_names en
          ${rankingJoin}
          WHERE ${whereClause}
        `;
      }

      // Build SELECT clause - need to include sort column when using DISTINCT
      // PostgreSQL requires ORDER BY columns to be in SELECT list when using DISTINCT
      let selectClause = 'DISTINCT en.name';
      if (sortBy === 'watchers_count') {
        selectClause = 'en.name, (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as sort_value';
      } else if (sortBy === 'view_count') {
        selectClause = 'DISTINCT en.name, COALESCE(en.view_count, 0) as sort_value';
      } else if (sortBy === 'last_sale_price') {
        selectClause = 'DISTINCT en.name, en.last_sale_price_usd';
      } else if (sortBy === 'expiry_date') {
        selectClause = 'DISTINCT en.name, en.expiry_date';
      } else if (sortBy === 'registration_date') {
        selectClause = 'DISTINCT en.name, en.registration_date';
      } else if (sortBy === 'creation_date') {
        selectClause = 'DISTINCT en.name, en.creation_date';
      } else if (sortBy === 'last_sale_date') {
        selectClause = 'DISTINCT en.name, en.last_sale_date';
      } else if (sortBy === 'character_count') {
        selectClause = 'DISTINCT en.name, LENGTH(REPLACE(en.name, \'.eth\', \'\')) as sort_value';
      } else if (sortBy === 'clubs_count') {
        // Include (en.name COLLATE "C") in SELECT to satisfy DISTINCT + ORDER BY requirement
        selectClause = 'DISTINCT en.name, (en.name COLLATE "C") as name_sort, COALESCE(array_length(en.clubs, 1), 0) as sort_value';
      } else if (sortBy === 'price') {
        // Use a subquery to get the max price for each name to avoid DISTINCT issues
        selectClause = 'en.name, (SELECT MAX(CAST(price_wei AS NUMERIC)) FROM listings WHERE ens_name_id = en.id AND status = \'active\') as sort_value';
      } else if (sortBy === 'offer') {
        selectClause = 'DISTINCT en.name, CAST(en.highest_offer_wei AS NUMERIC) as offer_sort';
      } else if (sortBy === 'listing_date') {
        selectClause = 'DISTINCT en.name, l.created_at as sort_value';
      } else if (sortBy === 'listing_expiry') {
        selectClause = 'DISTINCT en.name, l.expires_at as sort_value';
      } else if (sortBy === 'ranking') {
        selectClause = `DISTINCT en.name, cm_rank.rank as sort_value`;
      } else if (listingsOnly && !sortBy) {
        // Default sort for listings-only queries is l.created_at, must include it in SELECT
        selectClause = 'DISTINCT en.name, l.created_at';
      }

      // Build data query - use CTE with ROW_NUMBER() when uniqueSeller is enabled
      let dataQuery: string;
      if (uniqueSellerEnabled && listingsOnly) {
        // When uniqueSeller is enabled, get only the most recent listing per seller
        // Using ROW_NUMBER() to rank listings per seller, then filter to rn=1
        dataQuery = `
          WITH ranked_listings AS (
            SELECT en.name, l.seller_address, l.created_at, l.expires_at, l.price_wei,
                   en.expiry_date, en.registration_date, en.creation_date, en.last_sale_date, en.last_sale_price_usd,
                   en.view_count, en.highest_offer_wei, en.clubs, en.id as ens_name_id,
                   ROW_NUMBER() OVER (PARTITION BY l.seller_address ORDER BY l.created_at DESC) as rn
            FROM listings l
            JOIN ens_names en ON l.ens_name_id = en.id
            WHERE ${whereClause}
          )
          SELECT name${sortBy === 'price' ? ', CAST(price_wei AS NUMERIC) as sort_value' : sortBy === 'watchers_count' ? ', (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = ranked_listings.ens_name_id) as sort_value' : sortBy === 'view_count' ? ', COALESCE(view_count, 0) as sort_value' : sortBy === 'last_sale_price' ? ', last_sale_price_usd' : sortBy === 'expiry_date' ? ', expiry_date' : sortBy === 'registration_date' ? ', registration_date' : sortBy === 'creation_date' ? ', creation_date' : sortBy === 'last_sale_date' ? ', last_sale_date' : sortBy === 'listing_date' ? ', created_at as sort_value' : sortBy === 'listing_expiry' ? ', expires_at as sort_value' : sortBy === 'character_count' ? ", LENGTH(REPLACE(name, '.eth', '')) as sort_value" : sortBy === 'clubs_count' ? ', COALESCE(array_length(clubs, 1), 0) as sort_value' : sortBy === 'offer' ? ', CAST(highest_offer_wei AS NUMERIC) as offer_sort' : sortBy === 'ranking' ? ', cm_rank.rank as sort_value' : ', created_at'}
          FROM ranked_listings
          ${sortBy === 'ranking' ? rankingJoin.replace('en.name', 'ranked_listings.name') : ''}
          WHERE rn = 1
          ${orderByClause.replace(/en\./g, '').replace(/l\./g, '')}
          LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;
      } else if (listingsOnly) {
        dataQuery = `
          SELECT ${selectClause}
          FROM listings l
          JOIN ens_names en ON l.ens_name_id = en.id
          ${rankingJoin}
          WHERE ${whereClause}
          ${orderByClause}
          LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;
      } else {
        dataQuery = `
          SELECT ${selectClause}
          FROM ens_names en
          ${sortBy === 'price' ? '' : 'LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = \'active\''}
          ${rankingJoin}
          WHERE ${whereClause}
          ${orderByClause}
          LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;
      }

      params.push(limit, from);

      try {
        const [countResult, dataResult] = await Promise.all([
          pool.query(countQuery, params.slice(0, -2)),
          pool.query(dataQuery, params),
        ]);

        const total = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(total / limit);
        const currentPage = parseInt(page);

        // Extract names from result
        const ensNames = dataResult.rows.map((row: any) => row.name);

        // Handle export mode - use fast lightweight query
        if (isExport) {
          const exportRows = await fetchExportData(pool, ensNames);
          const csvContent = await exportRowsToCSV(exportRows);
          reply.header('Content-Type', 'text/csv');
          reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
          return reply.send(csvContent);
        }

        // Get user ID if authenticated
        const userId = request.user ? parseInt(request.user.sub) : undefined;

        // Build search results using shared utility
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

  // Bulk search with filters endpoint - searches for exact matches with filter/sort support
  // POST /api/v1/search/bulk-filters
  // Unlike /bulk, this endpoint:
  // - Applies filters during search (only returns names matching both terms AND filters)
  // - Paginates the filtered results (not the input terms)
  // - Does not return placeholder objects for not-found/filtered-out terms
  fastify.post('/bulk-filters', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      // Validate request body
      const parseResult = BulkFiltersSearchSchema.safeParse(request.body);
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

      const { terms, page, limit, sortBy, sortOrder, filters = {} } = parseResult.data;

      fastify.log.info(`Bulk filters search request: ${terms.length} terms, page ${page}, limit ${limit}, sortBy=${sortBy}, sortOrder=${sortOrder}`);

      // Normalize terms - add .eth suffix if not present
      const normalizedTerms = terms.map(term => {
        const lower = term.toLowerCase().trim();
        return lower.endsWith('.eth') ? lower : `${lower}.eth`;
      });

      // Resolve owner filter if provided (can be address or ENS name)
      let resolvedOwnerAddress: string | null = null;
      if (filters.owner) {
        const isAddress = /^0x[a-fA-F0-9]{40}$/.test(filters.owner);

        if (isAddress) {
          resolvedOwnerAddress = filters.owner.toLowerCase();
          fastify.log.info(`Bulk filters owner filter: address="${resolvedOwnerAddress}"`);
        } else {
          try {
            const resolveQuery = `
              SELECT owner_address
              FROM ens_names
              WHERE LOWER(name) = LOWER($1)
            `;
            const resolveResult = await pool.query(resolveQuery, [filters.owner]);

            if (resolveResult.rows.length > 0 && resolveResult.rows[0].owner_address) {
              resolvedOwnerAddress = resolveResult.rows[0].owner_address.toLowerCase();
              fastify.log.info(`Bulk filters owner filter: ENS name="${filters.owner}" resolved to address="${resolvedOwnerAddress}"`);
            } else {
              fastify.log.warn(`Bulk filters owner filter: ENS name="${filters.owner}" not found, will return no results`);
              resolvedOwnerAddress = '0x0000000000000000000000000000000000000000';
            }
          } catch (error: any) {
            fastify.log.error(`Error resolving ENS name "${filters.owner}":`, error.message);
            resolvedOwnerAddress = '0x0000000000000000000000000000000000000000';
          }
        }
      }

      // Check if PostgreSQL fallback is needed (for sorts/filters not in ES)
      let usePostgresql = sortBy === 'watchers_count';
      if (filters.marketplace && filters.marketplace !== 'all') {
        usePostgresql = true;
        fastify.log.info(`Bulk filters: Forcing PostgreSQL because marketplace filter="${filters.marketplace}"`);
      }

      // Try Elasticsearch first
      if (!usePostgresql) {
        try {
          // Build ES query using shared utility with ensNames to restrict to input terms
          const esQuery = buildESQuery({
            page,
            limit,
            sortBy,
            sortOrder,
            ensNames: normalizedTerms, // KEY: restricts search to input terms only
            // All supported filters
            minPrice: filters.minPrice,
            maxPrice: filters.maxPrice,
            minOffer: filters.minOffer,
            maxOffer: filters.maxOffer,
            minLength: filters.minLength,
            maxLength: filters.maxLength,
            hasNumbers: filters.hasNumbers,
            hasEmoji: filters.hasEmoji,
            digits: filters.digits,
            letters: filters.letters,
            emoji: filters.emoji,
            repeatingChars: filters.repeatingChars,
            contains: filters.contains,
            startsWith: filters.startsWith,
            endsWith: filters.endsWith,
            doesNotContain: filters.doesNotContain,
            doesNotStartWith: filters.doesNotStartWith,
            doesNotEndWith: filters.doesNotEndWith,
            listed: filters.listed,
            hasOffer: filters.hasOffer,
            showListings: filters.showListings,
            showUnlisted: filters.showUnlisted,
            clubs: filters.clubs,
            excludeClubs: filters.excludeClubs,
            inAnyClub: filters.inAnyClub,
            status: filters.status,
            isExpired: filters.isExpired,
            isGracePeriod: filters.isGracePeriod,
            isPremiumPeriod: filters.isPremiumPeriod,
            expiringWithinDays: filters.expiringWithinDays,
            includeExpired: filters.includeExpired,
            hasSales: filters.hasSales,
            lastSoldAfter: filters.lastSoldAfter,
            lastSoldBefore: filters.lastSoldBefore,
            minDaysSinceLastSale: filters.minDaysSinceLastSale,
            maxDaysSinceLastSale: filters.maxDaysSinceLastSale,
            minCreationDate: filters.minCreationDate,
            maxCreationDate: filters.maxCreationDate,
            resolvedOwnerAddress,
          });

          const esResult = await es.search(esQuery);

          // Extract names from ES results
          const foundNames = esResult.hits.hits.map((hit: any) => hit._source.name);
          const total = typeof esResult.hits.total === 'object'
            ? esResult.hits.total.value
            : (esResult.hits.total || 0);

          fastify.log.info(`Bulk filters ES search: ${foundNames.length} results from ${terms.length} input terms, total=${total}`);

          // Handle empty results
          if (foundNames.length === 0) {
            return reply.send({
              success: true,
              data: {
                results: [],
                pagination: {
                  page,
                  limit,
                  total: 0,
                  totalPages: 0,
                  hasNext: false,
                  hasPrev: false,
                },
                stats: {
                  inputTerms: terms.length,
                  matchedTerms: 0,
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

          // Build enriched results
          const results = await buildSearchResults(foundNames, userId);

          // If ES returned names but PostgreSQL has none, fall back to PostgreSQL
          if (results.length === 0 && foundNames.length > 0) {
            fastify.log.warn(`Bulk filters: ES returned ${foundNames.length} names but PostgreSQL has none. Falling back to PostgreSQL.`);
            usePostgresql = true;
          } else {
            const totalPages = Math.ceil(total / limit);

            const response: APIResponse<{
              results: SearchResult[];
              pagination: any;
              stats: any;
            }> = {
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
                stats: {
                  inputTerms: terms.length,
                  matchedTerms: total,
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
          fastify.log.warn('Bulk filters ES search failed, falling back to PostgreSQL:', error.message);
          usePostgresql = true;
        }
      }

      // PostgreSQL fallback
      if (usePostgresql) {
        // Build WHERE conditions
        const whereConditions: string[] = [];
        const params: any[] = [];
        let paramCount = 1;

        // Restrict to input terms
        const termPlaceholders = normalizedTerms.map((_, i) => `$${paramCount + i}`).join(',');
        whereConditions.push(`LOWER(en.name) IN (${termPlaceholders})`);
        params.push(...normalizedTerms);
        paramCount += normalizedTerms.length;

        // Exclude placeholder names
        whereConditions.push(`en.name NOT LIKE 'token-%'`);
        whereConditions.push(`en.name NOT LIKE '[%'`);
        whereConditions.push(`en.name NOT LIKE '%.%.eth'`);

        // Listing filters
        const hasMarketplaceFilter = filters.marketplace && filters.marketplace !== 'all';
        const listingsOnly = filters.listed === 'true' || filters.listed === true ||
                            filters.showListings === 'true' || filters.showListings === true ||
                            hasMarketplaceFilter;
        const unlistedOnly = filters.listed === 'false' || filters.listed === false ||
                            filters.showUnlisted === 'true' || filters.showUnlisted === true;

        if (listingsOnly) {
          whereConditions.push(`l.status = 'active'`);
        } else if (unlistedOnly) {
          whereConditions.push(`(l.id IS NULL OR l.status != 'active')`);
        }

        // Marketplace filter
        if (hasMarketplaceFilter) {
          whereConditions.push(`l.source = $${paramCount}`);
          params.push(filters.marketplace);
          paramCount++;
        }

        // Price filters
        if (filters.minPrice) {
          whereConditions.push(`l.price_wei >= $${paramCount}`);
          params.push(filters.minPrice);
          paramCount++;
        }
        if (filters.maxPrice) {
          whereConditions.push(`l.price_wei <= $${paramCount}`);
          params.push(filters.maxPrice);
          paramCount++;
        }

        // Length filters
        if (filters.minLength) {
          whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) >= $${paramCount}`);
          params.push(filters.minLength);
          paramCount++;
        }
        if (filters.maxLength) {
          whereConditions.push(`LENGTH(REPLACE(en.name, '.eth', '')) <= $${paramCount}`);
          params.push(filters.maxLength);
          paramCount++;
        }

        // Character filters
        if (filters.hasNumbers === 'true' || filters.hasNumbers === true) {
          whereConditions.push(`en.name ~ '[0-9]'`);
        } else if (filters.hasNumbers === 'false' || filters.hasNumbers === false) {
          whereConditions.push(`en.name !~ '[0-9]'`);
        }

        if (filters.hasEmoji === 'true' || filters.hasEmoji === true) {
          whereConditions.push(`en.has_emoji = true`);
        } else if (filters.hasEmoji === 'false' || filters.hasEmoji === false) {
          whereConditions.push(`en.has_emoji = false`);
        }

        // Club filters
        if (filters.clubs && filters.clubs.length > 0) {
          if (filters.clubs.includes('none')) {
            whereConditions.push(`(en.clubs IS NULL OR en.clubs = '{}')`);
          } else if (filters.clubs.includes('any')) {
            whereConditions.push(`en.clubs IS NOT NULL AND en.clubs != '{}'`);
          } else {
            whereConditions.push(`en.clubs && $${paramCount}::text[]`);
            params.push(filters.clubs);
            paramCount++;
          }
        }

        if (filters.inAnyClub === 'true' || filters.inAnyClub === true) {
          whereConditions.push(`en.clubs IS NOT NULL AND en.clubs != '{}'`);
        } else if (filters.inAnyClub === 'false' || filters.inAnyClub === false) {
          whereConditions.push(`(en.clubs IS NULL OR en.clubs = '{}')`);
        }

        // Status/expiration filters
        if (filters.status) {
          const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
          const statusConditions: string[] = [];
          for (const s of statuses) {
            if (s === 'registered') statusConditions.push(`en.expiry_date > NOW()`);
            else if (s === 'grace') statusConditions.push(`(en.expiry_date <= NOW() AND en.expiry_date > NOW() - INTERVAL '90 days')`);
            else if (s === 'premium') statusConditions.push(`(en.expiry_date <= NOW() - INTERVAL '90 days' AND en.expiry_date > NOW() - INTERVAL '111 days')`);
            else if (s === 'available') statusConditions.push(`en.expiry_date <= NOW() - INTERVAL '111 days'`);
          }
          if (statusConditions.length > 0) {
            whereConditions.push(`(${statusConditions.join(' OR ')})`);
          }
        }

        if (filters.isExpired === 'true' || filters.isExpired === true) {
          whereConditions.push(`en.expiry_date <= NOW()`);
        } else if (filters.isExpired === 'false' || filters.isExpired === false) {
          whereConditions.push(`en.expiry_date > NOW()`);
        }

        if (filters.expiringWithinDays) {
          whereConditions.push(`en.expiry_date > NOW() AND en.expiry_date <= NOW() + INTERVAL '${parseInt(String(filters.expiringWithinDays))} days'`);
        }

        // Owner filter
        if (resolvedOwnerAddress) {
          whereConditions.push(`LOWER(en.owner_address) = $${paramCount}`);
          params.push(resolvedOwnerAddress);
          paramCount++;
        }

        // Sale history filters
        if (filters.hasSales === 'true' || filters.hasSales === true) {
          whereConditions.push(`en.last_sale_date IS NOT NULL`);
        } else if (filters.hasSales === 'false' || filters.hasSales === false) {
          whereConditions.push(`en.last_sale_date IS NULL`);
        }

        // Build sort clause
        let orderBy = 'en.name ASC';
        if (sortBy) {
          const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
          const nullsLast = sortOrder === 'asc' ? 'NULLS LAST' : 'NULLS FIRST';
          switch (sortBy) {
            case 'price':
              orderBy = `l.price_wei ${order} ${nullsLast}, en.name ASC`;
              break;
            case 'expiry_date':
              orderBy = `en.expiry_date ${order} ${nullsLast}, en.name ASC`;
              break;
            case 'registration_date':
              orderBy = `en.registration_date ${order} ${nullsLast}, en.name ASC`;
              break;
            case 'creation_date':
              orderBy = `en.creation_date ${order} ${nullsLast}, en.name ASC`;
              break;
            case 'last_sale_date':
              orderBy = `en.last_sale_date ${order} ${nullsLast}, en.name ASC`;
              break;
            case 'character_count':
              orderBy = `LENGTH(REPLACE(en.name, '.eth', '')) ${order}, en.name ASC`;
              break;
            case 'watchers_count':
              orderBy = `watchers_count ${order} ${nullsLast}, en.name ASC`;
              break;
            case 'listing_date':
              orderBy = `l.created_at ${order} NULLS LAST, en.name ASC`;
              break;
            case 'listing_expiry':
              orderBy = `l.expires_at ${order} NULLS LAST, en.name ASC`;
              break;
            case 'alphabetical':
              orderBy = `en.name ${order}`;
              break;
          }
        }

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        const offset = (page - 1) * limit;

        // Count query
        const countQuery = `
          SELECT COUNT(DISTINCT en.id) as total
          FROM ens_names en
          LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
          ${whereClause}
        `;

        // Data query
        const dataQuery = `
          SELECT DISTINCT en.name,
            (SELECT COUNT(*) FROM watchlist w WHERE w.ens_name_id = en.id) as watchers_count
          FROM ens_names en
          LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
          ${whereClause}
          ORDER BY ${orderBy}
          LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        const [countResult, dataResult] = await Promise.all([
          pool.query(countQuery, params),
          pool.query(dataQuery, [...params, limit, offset]),
        ]);

        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);
        const foundNames = dataResult.rows.map((row: any) => row.name);

        fastify.log.info(`Bulk filters PostgreSQL search: ${foundNames.length} results from ${terms.length} input terms, total=${total}`);

        // Handle empty results
        if (foundNames.length === 0) {
          return reply.send({
            success: true,
            data: {
              results: [],
              pagination: {
                page,
                limit,
                total: 0,
                totalPages: 0,
                hasNext: false,
                hasPrev: false,
              },
              stats: {
                inputTerms: terms.length,
                matchedTerms: 0,
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

        // Build enriched results
        const results = await buildSearchResults(foundNames, userId);

        const response: APIResponse<{
          results: SearchResult[];
          pagination: any;
          stats: any;
        }> = {
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
            stats: {
              inputTerms: terms.length,
              matchedTerms: total,
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
      fastify.log.error({ error }, 'Bulk filters search failed');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'SEARCH_ERROR',
          message: 'Bulk filters search failed',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
