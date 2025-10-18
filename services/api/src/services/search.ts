import { getElasticsearchClient, config } from '../../../shared/src';

interface SearchQuery {
  q: string;
  page: number;
  limit: number;
  filters?: {
    minPrice?: string;
    maxPrice?: string;
    minLength?: number;
    maxLength?: number;
    hasNumbers?: boolean;
    hasEmoji?: boolean;
    clubs?: string[];  // Array of club names to filter by
  };
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
        sort: [
          { _score: { order: 'desc' } },
          { listing_created_at: { order: 'desc' } },
        ],
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