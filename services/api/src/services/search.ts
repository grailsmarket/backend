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
  sortBy?: 'price' | 'expiry_date' | 'registration_date' | 'creation_date' | 'last_sale_date' | 'last_sale_price' | 'character_count' | 'watchers_count' | 'offer';
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
      // Use clubs.keyword for exact matching (clubs is a text field with keyword subfield)
      filter.push({ terms: { 'clubs.keyword': query.filters.clubs } });
    }

    // Expiration filters - use dynamic date calculations instead of stale ES boolean fields
    // ENS expiration states:
    // - Not expired: expiry_date > now
    // - Expired (grace period): expiry_date <= now AND expiry_date > now - 90 days
    // - Expired (premium period): expiry_date <= now - 90 days AND expiry_date > now - 111 days
    // - Fully expired: expiry_date <= now - 111 days
    if (query.filters.isExpired !== undefined) {
      filter.push({ exists: { field: 'expiry_date' } });
      if (query.filters.isExpired) {
        // Expired: expiry_date is in the past
        filter.push({ range: { expiry_date: { lte: 'now' } } });
      } else {
        // Not expired: expiry_date is in the future
        filter.push({ range: { expiry_date: { gt: 'now' } } });
      }
    }

    if (query.filters.isGracePeriod !== undefined) {
      filter.push({ exists: { field: 'expiry_date' } });
      if (query.filters.isGracePeriod) {
        // In grace period: expired but within 90 days of expiry
        filter.push({ range: { expiry_date: { lte: 'now', gt: 'now-90d' } } });
      } else {
        // Not in grace period: either not expired OR past grace period
        filter.push({
          bool: {
            should: [
              { range: { expiry_date: { gt: 'now' } } },  // Not expired
              { range: { expiry_date: { lte: 'now-90d' } } }  // Past grace period
            ],
            minimum_should_match: 1
          }
        });
      }
    }

    if (query.filters.isPremiumPeriod !== undefined) {
      filter.push({ exists: { field: 'expiry_date' } });
      if (query.filters.isPremiumPeriod) {
        // In premium period: 90-111 days after expiry (21 day Dutch auction)
        filter.push({ range: { expiry_date: { lte: 'now-90d', gt: 'now-111d' } } });
      } else {
        // Not in premium period: not expired, in grace period, or fully expired
        filter.push({
          bool: {
            should: [
              { range: { expiry_date: { gt: 'now-90d' } } },  // Not expired or in grace
              { range: { expiry_date: { lte: 'now-111d' } } }  // Past premium period
            ],
            minimum_should_match: 1
          }
        });
      }
    }

    if (query.filters.expiringWithinDays !== undefined) {
      // Filter for names expiring within X days (not yet expired)
      // Use dynamic date range instead of stale days_until_expiry field
      const days = query.filters.expiringWithinDays;
      filter.push({
        bool: {
          must: [
            { exists: { field: 'expiry_date' } },
            { range: { expiry_date: { gt: 'now', lte: `now+${days}d` } } }
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
      // Use dynamic date calculation instead of stale days_since_last_sale field
      // minDaysSinceLastSale=30 means "sold at least 30 days ago" -> last_sale_date <= now-30d
      const days = query.filters.minDaysSinceLastSale;
      filter.push({
        range: {
          last_sale_date: {
            lte: `now-${days}d`,
          },
        },
      });
    }

    if (query.filters.maxDaysSinceLastSale !== undefined) {
      // Use dynamic date calculation instead of stale days_since_last_sale field
      // maxDaysSinceLastSale=90 means "sold within last 90 days" -> last_sale_date >= now-90d
      const days = query.filters.maxDaysSinceLastSale;
      filter.push({
        range: {
          last_sale_date: {
            gte: `now-${days}d`,
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