import { getElasticsearchClient, config } from '../../../shared/src';

interface SearchQuery {
  q: string;
  page: number;
  limit: number;
  ensNames?: string[];  // Optional: restrict search to specific ENS names (for watchlist filtering)
  filters?: {
    minPrice?: string;
    maxPrice?: string;
    minLength?: number;
    maxLength?: number;
    hasNumbers?: boolean;
    hasEmoji?: boolean;
    clubs?: string[];  // Array of club names to filter by
    isExpired?: boolean;
    isGracePeriod?: boolean;
    isPremiumPeriod?: boolean;
    expiringWithinDays?: number;
    hasSales?: boolean;
    lastSoldAfter?: string;  // ISO date string
    lastSoldBefore?: string;  // ISO date string
    minDaysSinceLastSale?: number;
    maxDaysSinceLastSale?: number;
  };
  sortBy?: 'price' | 'expiry_date' | 'registration_date' | 'last_sale_date' | 'character_count';
  sortOrder?: 'asc' | 'desc';
}

export async function searchNames(query: SearchQuery) {
  const es = getElasticsearchClient();
  const from = (query.page - 1) * query.limit;

  // Build must clause - use match_all for wildcard, multi_match otherwise
  const must: any[] = [];

  if (query.q === '*' || query.q === '') {
    // Wildcard search - match all documents
    must.push({ match_all: {} });
  } else {
    // Text search - NO ngram (causes too many false positives with 2-char matches)
    must.push({
      bool: {
        should: [
          // Exact match on keyword field (highest priority)
          {
            term: {
              'name.keyword': {
                value: query.q + '.eth',
                boost: 10,
              },
            },
          },
          // Prefix match (e.g., "test" matches "testing.eth")
          {
            prefix: {
              name: {
                value: query.q,
                boost: 5,
              },
            },
          },
          // Contains match using wildcard
          {
            wildcard: {
              name: {
                value: `*${query.q}*`,
                boost: 2,
              },
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }

  const filter: any[] = [];

  // Filter by specific ENS names (used for watchlist filtering)
  if (query.ensNames && query.ensNames.length > 0) {
    filter.push({ terms: { 'name.keyword': query.ensNames } });
  }

  if (query.filters) {
    if (query.filters.minPrice || query.filters.maxPrice) {
      const range: any = {};
      if (query.filters.minPrice) range.gte = query.filters.minPrice;
      if (query.filters.maxPrice) range.lte = query.filters.maxPrice;
      filter.push({ range: { price: range } });
    }

    if (query.filters.minLength !== undefined || query.filters.maxLength !== undefined) {
      const range: any = {};
      if (query.filters.minLength !== undefined) range.gte = query.filters.minLength;
      if (query.filters.maxLength !== undefined) range.lte = query.filters.maxLength;
      filter.push({ range: { character_count: range } });
    }

    if (query.filters.hasNumbers !== undefined) {
      filter.push({ term: { has_numbers: query.filters.hasNumbers } });
    }

    if (query.filters.hasEmoji !== undefined) {
      filter.push({ term: { has_emoji: query.filters.hasEmoji } });
    }

    if (query.filters.clubs && query.filters.clubs.length > 0) {
      // Filter by clubs - name must be in at least one of the specified clubs
      filter.push({ terms: { clubs: query.filters.clubs } });
    }

    // Expiration filters - exclude names without expiry dates (placeholders)
    if (query.filters.isExpired !== undefined) {
      filter.push({ term: { is_expired: query.filters.isExpired } });
      filter.push({ exists: { field: 'expiry_date' } });
    }

    if (query.filters.isGracePeriod !== undefined) {
      filter.push({ term: { is_grace_period: query.filters.isGracePeriod } });
      filter.push({ exists: { field: 'expiry_date' } });
    }

    if (query.filters.isPremiumPeriod !== undefined) {
      filter.push({ term: { is_premium_period: query.filters.isPremiumPeriod } });
      filter.push({ exists: { field: 'expiry_date' } });
    }

    if (query.filters.expiringWithinDays !== undefined) {
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
                  lte: query.filters.expiringWithinDays,
                },
              },
            },
          ],
        },
      });
    }

    // Sale history filters
    if (query.filters.hasSales !== undefined) {
      filter.push({ term: { has_sales: query.filters.hasSales } });
    }

    if (query.filters.lastSoldAfter) {
      filter.push({
        range: {
          last_sale_date: {
            gte: query.filters.lastSoldAfter,
          },
        },
      });
    }

    if (query.filters.lastSoldBefore) {
      filter.push({
        range: {
          last_sale_date: {
            lte: query.filters.lastSoldBefore,
          },
        },
      });
    }

    if (query.filters.minDaysSinceLastSale !== undefined) {
      filter.push({
        range: {
          days_since_last_sale: {
            gte: query.filters.minDaysSinceLastSale,
          },
        },
      });
    }

    if (query.filters.maxDaysSinceLastSale !== undefined) {
      filter.push({
        range: {
          days_since_last_sale: {
            lte: query.filters.maxDaysSinceLastSale,
          },
        },
      });
    }
  }

  // Build sort array
  const sort: any[] = [{ _score: { order: 'desc' } }];

  if (query.sortBy) {
    const sortOrder = query.sortOrder || 'desc';
    sort.push({ [query.sortBy]: { order: sortOrder } });
  } else {
    sort.push({ listing_created_at: { order: 'desc' } });
  }

  try {
    const response = await es.search({
      index: config.elasticsearch.index,
      body: {
        query: {
          bool: {
            must,
            filter: filter.length > 0 ? filter : undefined,
          },
        },
        from,
        size: query.limit,
        sort,
        highlight: {
          fields: {
            name: {},
          },
        },
      },
    });

    const hits = response.hits.hits.map((hit: any) => ({
      ...hit._source,
      score: hit._score,
      highlight: hit.highlight,
    }));

    const totalCount = typeof response.hits.total === 'object' && response.hits.total ? response.hits.total.value : response.hits.total as number;
    const totalPages = Math.ceil(totalCount / query.limit);

    return {
      results: hits,
      total: response.hits.total,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: totalCount,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrev: query.page > 1,
      },
    };
  } catch (error) {
    console.error('Elasticsearch search error:', error);
    return {
      results: [],
      total: 0,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
  }
}