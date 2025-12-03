import { FastifyInstance } from 'fastify';
import { getPostgresPool, getElasticsearchClient, APIResponse } from '../../../shared/src';
import { buildSearchResults } from '../utils/response-builder';
import { optionalAuth } from '../middleware/auth';

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
              // Convert to string for clubs filter
              const val = filterName === 'clubs' ? String(value) : value;
              transformedQuery.filters[filterName].push(val);
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
    const { minPrice, maxPrice, minLength, maxLength, hasEmoji, hasNumbers, showListings = false, showUnlisted = false, clubs, isExpired, isGracePeriod, isPremiumPeriod, expiringWithinDays, hasSales, lastSoldAfter, lastSoldBefore, minDaysSinceLastSale, maxDaysSinceLastSale, owner, includeExpired = false } = filters;
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

    fastify.log.info(`Search request: q="${q}", page=${page}, limit=${limit}, minLength=${minLength}, maxLength=${maxLength}, hasEmoji=${hasEmoji}, hasNumbers=${hasNumbers}, showListings=${showListings}, showUnlisted=${showUnlisted}, clubs=${Array.isArray(clubs) ? clubs.join(',') : clubs}, isExpired=${isExpired}, isGracePeriod=${isGracePeriod}, isPremiumPeriod=${isPremiumPeriod}, expiringWithinDays=${expiringWithinDays}, hasSales=${hasSales}, owner=${owner}, resolvedOwner=${resolvedOwnerAddress}, sortBy=${sortBy}`);

    // Try Elasticsearch first, but fall back to PostgreSQL if it fails
    // Also force PostgreSQL for sorts that don't exist in Elasticsearch
    let usePostgresql = sortBy === 'watchers_count';

    if (usePostgresql) {
      fastify.log.info('Forcing PostgreSQL because sortBy=watchers_count (not available in Elasticsearch)');
    }

    // Build Elasticsearch query
    const must: any[] = [];
    const filter: any[] = [];

    // Exclude placeholder names from all searches
    // Only exclude token-* prefixes, not numeric names (which are valid ENS names in clubs like 999, 10k)
    filter.push({
      bool: {
        must_not: [
          { prefix: { 'name.keyword': 'token-' } }
        ]
      }
    });

    if (includeExpired !== true && includeExpired !== 'true') {
      filter.push({
        bool: {
          should: [
            { bool: { must_not: { exists: { field: 'expiry_date' } } } },
            { range: { expiry_date: { gte: 'now-90d' } } }
          ],
          minimum_should_match: 1
        }
      });
    }

    // Exclude subnames - only match *.eth pattern (not *.*.eth or deeper)
    filter.push({
      bool: {
        must_not: [
          { wildcard: { 'name.keyword': '*.*.eth' } }
        ]
      }
    });

    // Filter by listing status
    // When sorting by price, we should only show listings
    // When showListings is explicitly true, filter to active listings
    // When showUnlisted is explicitly true, filter to names WITHOUT active listings
    if (showListings === true || showListings === 'true' || sortBy === 'price') {
      filter.push({ term: { status: 'active' } });
    } else if (showUnlisted === true || showUnlisted === 'true') {
      filter.push({
        bool: {
          must_not: [
            { term: { status: 'active' } }
          ]
        }
      });
    }

    if (q) {
      // Normalize query - add .eth suffix if not present for exact match checking
      const normalizedQuery = q.toLowerCase();
      const queryWithEth = normalizedQuery.endsWith('.eth') ? normalizedQuery : `${normalizedQuery}.eth`;

      must.push({
        bool: {
          should: [
            // Exact keyword match gets MASSIVE boost (both with and without .eth)
            { term: { 'name.keyword': { value: queryWithEth, boost: 1000 } } },
            { term: { 'name.keyword': { value: normalizedQuery, boost: 1000 } } },
            // Full-text exact match gets very high boost
            { match: { name: { query: q, boost: 10 } } },
            // Prefix match gets high boost
            { prefix: { name: { value: q, boost: 5 } } },
            // Ngram match for fuzzy matching (lower boost)
            { match: { 'name.ngram': { query: q, boost: 1 } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    if (minPrice || maxPrice) {
      const range: any = {};
      if (minPrice) range.gte = minPrice;
      if (maxPrice) range.lte = maxPrice;
      filter.push({ range: { price: range } });
    }

    // Add length filters using script query
    if (minLength || maxLength) {
      const scriptConditions: string[] = [];
      if (minLength) {
        scriptConditions.push(`doc['name.keyword'].value.replace('.eth', '').length() >= ${parseInt(minLength)}`);
      }
      if (maxLength) {
        scriptConditions.push(`doc['name.keyword'].value.replace('.eth', '').length() <= ${parseInt(maxLength)}`);
      }
      filter.push({
        script: {
          script: {
            source: scriptConditions.join(' && '),
            lang: 'painless',
          },
        },
      });
    }

    // Add emoji filter
    if (hasEmoji !== undefined) {
      filter.push({ term: { has_emoji: hasEmoji === 'true' || hasEmoji === true } });
    }

    // Add numbers filter
    if (hasNumbers !== undefined) {
      filter.push({ term: { has_numbers: hasNumbers === 'true' || hasNumbers === true } });
    }

    // Add clubs filter
    if (clubs && clubs.length > 0) {
      filter.push({ terms: { clubs: clubs } });
    }

    // Add owner filter
    if (resolvedOwnerAddress) {
      filter.push({ term: { owner: resolvedOwnerAddress } });
    }

    // Expiration filters - exclude names without expiry dates (placeholders)
    if (isExpired !== undefined) {
      filter.push({ term: { is_expired: isExpired === 'true' || isExpired === true } });
      filter.push({ exists: { field: 'expiry_date' } });
    }

    if (isGracePeriod !== undefined) {
      filter.push({ term: { is_grace_period: isGracePeriod === 'true' || isGracePeriod === true } });
      filter.push({ exists: { field: 'expiry_date' } });
    }

    if (isPremiumPeriod !== undefined) {
      filter.push({ term: { is_premium_period: isPremiumPeriod === 'true' || isPremiumPeriod === true } });
      filter.push({ exists: { field: 'expiry_date' } });
    }

    if (expiringWithinDays !== undefined) {
      // Filter for names expiring within X days (positive number, not yet expired)
      // Only include names with valid expiry dates
      filter.push({
        bool: {
          must: [
            { exists: { field: 'expiry_date' } },
            {
              range: {
                days_until_expiry: {
                  gte: 0,
                  lte: parseInt(expiringWithinDays),
                },
              },
            },
          ],
        },
      });
    }

    // Sale history filters
    if (hasSales !== undefined) {
      filter.push({ term: { has_sales: hasSales === 'true' || hasSales === true } });
    }

    if (lastSoldAfter) {
      filter.push({
        range: {
          last_sale_date: {
            gte: lastSoldAfter,
          },
        },
      });
    }

    if (lastSoldBefore) {
      filter.push({
        range: {
          last_sale_date: {
            lte: lastSoldBefore,
          },
        },
      });
    }

    if (minDaysSinceLastSale !== undefined) {
      filter.push({
        range: {
          days_since_last_sale: {
            gte: parseInt(minDaysSinceLastSale as any),
          },
        },
      });
    }

    if (maxDaysSinceLastSale !== undefined) {
      filter.push({
        range: {
          days_since_last_sale: {
            lte: parseInt(maxDaysSinceLastSale as any),
          },
        },
      });
    }

    // Build sort array
    const sort: any[] = [];
    if (sortBy) {
      const order = sortOrder || 'desc';

      // Special handling for fields that may have null values
      if (sortBy === 'price') {
        // Sort by listing price
        sort.push({
          'price': {
            order,
            missing: '_last'  // Put documents without listings at the end
          }
        });
      } else if (sortBy === 'last_sale_price') {
        // Sort by USD value, not raw wei/token amount
        sort.push({
          'last_sale_price_usd': {
            order,
            missing: '_last'  // Put documents without this field at the end
          }
        });
      } else if (sortBy === 'watchers_count') {
        // watchers_count doesn't exist in ES, will fall back to PostgreSQL
        // But prepare sort config in case it's added later
        sort.push({
          [sortBy]: {
            order,
            missing: '_last'
          }
        });
      } else {
        sort.push({ [sortBy]: { order } });
      }
    } else if (resolvedOwnerAddress) {
      // When filtering by owner without explicit sort, use a stable alphabetical sort by name
      // This prevents documents from moving around due to ES internal state changes
      sort.push({ 'name.keyword': { order: 'asc' } });
    } else {
      sort.push({ _score: { order: 'desc' } });
      sort.push({ listing_created_at: { order: 'desc' } });
    }

    // Dynamic min_score based on query length
    // Short queries (1-3 chars) need lower threshold because they rely on prefix/ngram matching
    // Longer queries can use higher threshold for better relevance
    let minScore: number | undefined = undefined;
    if (q) {
      if (q.length <= 3) {
        minScore = 1.0;  // Very low threshold for short queries (e.g., "241", "abc")
      } else if (q.length <= 5) {
        minScore = 5.0;  // Low threshold for medium queries
      } else {
        minScore = 20.0; // Original threshold for longer queries
      }
    }

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

      // Debug: Check first 5 results when sorting by price
      if (sortBy === 'price' && esResult.hits.hits.length > 0) {
        const first5 = esResult.hits.hits.slice(0, 5).map((hit: any) => ({
          name: hit._source.name,
          price: hit._source.price,
          status: hit._source.status
        }));
        fastify.log.info(`First 5 ES results: ${JSON.stringify(first5)}`);
      }

      // Extract ENS names from Elasticsearch results
      const allNames = esResult.hits.hits.map((hit: any) => hit._source.name);

      // Filter out placeholder names (token-###)
      // Note: Numeric names like 0000.eth are valid ENS names (999 club, 10k club, etc.)
      const ensNames = allNames.filter((name: string) => {
        return name && !name.startsWith('token-');
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
      // showListings=true means only show names with active listings (opposite of old showAll)
      // showUnlisted=true means only show names WITHOUT active listings
      const listingsOnly = showListings === true || showListings === 'true';
      const unlistedOnly = showUnlisted === true || showUnlisted === 'true';
      let whereConditions: string[] = [];
      let params: any[] = [];
      let paramCount = 1;

      if (includeExpired !== true && includeExpired !== 'true') {
        whereConditions.push(`(en.expiry_date IS NULL OR en.expiry_date + INTERVAL '90 days' > NOW())`);
      }

      // Exclude subnames - only show *.eth pattern (not *.*.eth or deeper)
      whereConditions.push(`en.name NOT LIKE '%.%.eth'`);

      // Filter by listing status
      if (listingsOnly) {
        whereConditions.push(`l.status = $${paramCount}`);
        params.push('active');
        paramCount++;
      } else if (unlistedOnly) {
        // Only show names that don't have an active listing
        whereConditions.push(`(l.id IS NULL OR l.status != 'active')`);
      }

      fastify.log.info(`Using PostgreSQL fallback, query="${q}", showListings=${listingsOnly}, showUnlisted=${unlistedOnly}, sortBy=${sortBy}, sortOrder=${sortOrder}`);

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
}
