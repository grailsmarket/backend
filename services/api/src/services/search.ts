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
  };
}

export async function searchNames(query: SearchQuery) {
  const es = getElasticsearchClient();
  const from = (query.page - 1) * query.limit;

  const must: any[] = [
    {
      multi_match: {
        query: query.q,
        fields: ['name^3', 'name.ngram'],
        type: 'best_fields',
      },
    },
  ];

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

    return {
      results: hits,
      total: response.hits.total,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: typeof response.hits.total === 'object' && response.hits.total ? response.hits.total.value : response.hits.total as number,
        hasNext: from + query.limit < (typeof response.hits.total === 'object' && response.hits.total ? response.hits.total.value : response.hits.total as number),
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
        hasNext: false,
        hasPrev: false,
      },
    };
  }
}