/**
 * Shared Elasticsearch filter and sort building utilities
 * Used by both /search and /watchlist/search endpoints
 */

export interface ESFilterOptions {
  // Search query
  q?: string;

  // Pagination
  page?: number;
  limit?: number;

  // Price filters
  minPrice?: string;
  maxPrice?: string;

  // Offer filters
  minOffer?: string;
  maxOffer?: string;

  // Length filters
  minLength?: number | string;
  maxLength?: number | string;

  // Legacy character filters
  hasEmoji?: boolean | string;
  hasNumbers?: boolean | string;

  // Tri-state character filters: 'include' | 'exclude' | 'only'
  digits?: string;
  letters?: string;
  emoji?: string;
  repeatingChars?: string;

  // String pattern filters
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  doesNotContain?: string;
  doesNotStartWith?: string;
  doesNotEndWith?: string;

  // Listing status filters
  listed?: boolean | string;
  showListings?: boolean | string;
  showUnlisted?: boolean | string;

  // Offer filter
  hasOffer?: boolean | string;

  // Marketplace filter
  marketplace?: string;

  // Club filters
  clubs?: string[];
  excludeClubs?: string[];
  inAnyClub?: boolean | string;

  // Owner filter (resolved address)
  resolvedOwnerAddress?: string | null;

  // Unified status filter: 'registered' | 'grace' | 'premium' | 'available' | 'all'
  // Supports single value or array for multiple statuses (OR logic)
  status?: string | string[];

  // Legacy expiration filters
  isExpired?: boolean | string;
  isGracePeriod?: boolean | string;
  isPremiumPeriod?: boolean | string;
  expiringWithinDays?: number | string;

  // Include expired names (default: false)
  includeExpired?: boolean | string;

  // Sale history filters
  hasSales?: boolean | string;
  lastSoldAfter?: string;
  lastSoldBefore?: string;
  minDaysSinceLastSale?: number | string;
  maxDaysSinceLastSale?: number | string;

  // For watchlist: restrict to specific ENS names
  ensNames?: string[];

  // Sort options
  sortBy?: string;
  sortOrder?: string;
}

export interface ESQueryResult {
  must: any[];
  filter: any[];
  sort: any[];
  minScore?: number;
}

/**
 * Build Elasticsearch filter and must arrays from filter options
 */
export function buildESFilters(options: ESFilterOptions): { must: any[]; filter: any[] } {
  const must: any[] = [];
  const filter: any[] = [];

  const {
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
    ensNames,
    sortBy,
  } = options;

  // Exclude placeholder names from all searches
  filter.push({
    bool: {
      must_not: [
        { prefix: { 'name.keyword': 'token-' } },
        { prefix: { 'name.keyword': '[' } }
      ]
    }
  });

  // Determine when to apply the "exclude premium/available" filter
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
  const hasExplicitStatusFilter = status !== undefined &&
    (Array.isArray(status) ? status.length > 0 && !status.includes('all') : status !== 'all');
  const hasExplicitExpirationFilter =
    isExpired !== undefined ||
    isGracePeriod !== undefined ||
    isPremiumPeriod !== undefined ||
    hasExplicitStatusFilter;

  // Only apply the default "exclude premium/available" filter for specific cases
  const shouldExcludePremiumAvailable =
    includeExpired !== true &&
    includeExpired !== 'true' &&
    !hasExplicitExpirationFilter &&
    (resolvedOwnerAddress || sortBy === 'expiry_date' || sortBy === 'price');

  if (shouldExcludePremiumAvailable) {
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
        { wildcard: { 'name.keyword': '*.*.eth' } },
        { prefix: { 'name.keyword': 'token-' } },
        { prefix: { 'name.keyword': '[' } }
      ]
    }
  });

  // Restrict to specific ENS names (for watchlist)
  if (ensNames && ensNames.length > 0) {
    filter.push({
      terms: { 'name.keyword': ensNames.map(n => n.toLowerCase()) }
    });
  }

  // Filter by listing status
  if (listed === 'true' || listed === true || showListings === true || showListings === 'true' || sortBy === 'price') {
    filter.push({ term: { status: 'active' } });
  } else if (listed === 'false' || listed === false || showUnlisted === true || showUnlisted === 'true') {
    filter.push({
      bool: {
        must_not: [{ term: { status: 'active' } }]
      }
    });
  }

  // Filter by offer status
  if (hasOffer === 'true' || hasOffer === true) {
    filter.push({
      bool: {
        must: [
          { exists: { field: 'highest_offer' } },
          { range: { highest_offer: { gt: 0 } } }
        ]
      }
    });
  } else if (hasOffer === 'false' || hasOffer === false) {
    filter.push({
      bool: {
        should: [
          { bool: { must_not: { exists: { field: 'highest_offer' } } } },
          { range: { highest_offer: { lte: 0 } } }
        ],
        minimum_should_match: 1
      }
    });
  }

  // Search query
  if (q) {
    const normalizedQuery = q.toLowerCase();
    const queryWithEth = normalizedQuery.endsWith('.eth') ? normalizedQuery : `${normalizedQuery}.eth`;

    must.push({
      bool: {
        should: [
          { term: { 'name.keyword': { value: queryWithEth, boost: 1000 } } },
          { term: { 'name.keyword': { value: normalizedQuery, boost: 1000 } } },
          { match: { name: { query: q, boost: 10 } } },
          { prefix: { name: { value: q, boost: 5 } } },
          { match: { 'name.ngram': { query: q, boost: 1 } } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  // Price filters
  if (minPrice || maxPrice) {
    const range: any = {};
    if (minPrice) range.gte = minPrice;
    if (maxPrice) range.lte = maxPrice;
    filter.push({ range: { price: range } });
  }

  // Offer filters
  if (minOffer || maxOffer) {
    const range: any = {};
    if (minOffer) range.gte = minOffer;
    if (maxOffer) range.lte = maxOffer;
    filter.push({ range: { highest_offer: range } });
  }

  // Length filters
  if (minLength || maxLength) {
    const scriptConditions: string[] = [];
    if (minLength) {
      scriptConditions.push(`doc['name.keyword'].value.replace('.eth', '').length() >= ${parseInt(String(minLength))}`);
    }
    if (maxLength) {
      scriptConditions.push(`doc['name.keyword'].value.replace('.eth', '').length() <= ${parseInt(String(maxLength))}`);
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

  // String pattern filters
  if (contains) {
    const normalizedContains = contains.toLowerCase();
    filter.push({
      wildcard: {
        'name.keyword': {
          value: `*${normalizedContains}*`,
          case_insensitive: true
        }
      }
    });
  }

  if (startsWith) {
    const normalizedStartsWith = startsWith.toLowerCase();
    filter.push({
      prefix: {
        'name.keyword': {
          value: normalizedStartsWith,
          case_insensitive: true
        }
      }
    });
  }

  if (endsWith) {
    const normalizedEndsWith = endsWith.toLowerCase();
    filter.push({
      wildcard: {
        'name.keyword': {
          value: `*${normalizedEndsWith}.eth`,
          case_insensitive: true
        }
      }
    });
  }

  if (doesNotContain) {
    const normalizedDoesNotContain = doesNotContain.toLowerCase();
    filter.push({
      bool: {
        must_not: {
          wildcard: {
            'name.keyword': {
              value: `*${normalizedDoesNotContain}*`,
              case_insensitive: true
            }
          }
        }
      }
    });
  }

  if (doesNotStartWith) {
    const normalizedDoesNotStartWith = doesNotStartWith.toLowerCase();
    filter.push({
      bool: {
        must_not: {
          wildcard: {
            'name.keyword': {
              value: `${normalizedDoesNotStartWith}*`,
              case_insensitive: true
            }
          }
        }
      }
    });
  }

  if (doesNotEndWith) {
    const normalizedDoesNotEndWith = doesNotEndWith.toLowerCase();
    filter.push({
      bool: {
        must_not: {
          wildcard: {
            'name.keyword': {
              value: `*${normalizedDoesNotEndWith}.eth`,
              case_insensitive: true
            }
          }
        }
      }
    });
  }

  // Legacy emoji filter
  if (hasEmoji !== undefined) {
    filter.push({ term: { has_emoji: hasEmoji === 'true' || hasEmoji === true } });
  }

  // Legacy numbers filter
  if (hasNumbers !== undefined) {
    filter.push({ term: { has_numbers: hasNumbers === 'true' || hasNumbers === true } });
  }

  // Tri-state digits filter
  if (digits === 'exclude') {
    filter.push({ term: { has_numbers: false } });
  } else if (digits === 'only') {
    filter.push({
      script: {
        script: {
          source: "/^[0-9]+\\.eth$/.matcher(doc['name.keyword'].value).matches()",
          lang: 'painless',
        },
      },
    });
  }

  // Tri-state letters filter
  if (letters === 'exclude') {
    filter.push({
      script: {
        script: {
          source: "!(/[a-zA-Z]/.matcher(doc['name.keyword'].value.replace('.eth', '')).find())",
          lang: 'painless',
        },
      },
    });
  } else if (letters === 'only') {
    filter.push({
      script: {
        script: {
          source: "/^[a-zA-Z]+\\.eth$/.matcher(doc['name.keyword'].value).matches()",
          lang: 'painless',
        },
      },
    });
  }

  // Tri-state emoji filter
  if (emoji === 'exclude') {
    filter.push({ term: { has_emoji: false } });
  } else if (emoji === 'only') {
    filter.push({ term: { has_emoji: true } });
    filter.push({
      script: {
        script: {
          source: "!(/[a-zA-Z0-9]/.matcher(doc['name.keyword'].value.replace('.eth', '')).find())",
          lang: 'painless',
        },
      },
    });
  }

  // Tri-state repeatingChars filter
  if (repeatingChars === 'exclude') {
    filter.push({
      script: {
        script: {
          source: `
            def label = doc['name.keyword'].value.replace('.eth', '');
            if (label.length() == 0) return true;
            def firstChar = label.charAt(0);
            for (int i = 1; i < label.length(); i++) {
              if (label.charAt(i) != firstChar) {
                return true;
              }
            }
            return false;
          `,
          lang: 'painless',
        },
      },
    });
  } else if (repeatingChars === 'only') {
    filter.push({
      script: {
        script: {
          source: `
            def label = doc['name.keyword'].value.replace('.eth', '');
            if (label.length() == 0) return false;
            def firstChar = label.charAt(0);
            for (int i = 1; i < label.length(); i++) {
              if (label.charAt(i) != firstChar) {
                return false;
              }
            }
            return true;
          `,
          lang: 'painless',
        },
      },
    });
  }

  // Clubs filter - handle special values 'none' and 'any'
  if (clubs && clubs.length > 0) {
    if (clubs.includes('none')) {
      // 'none' means names NOT in any club
      filter.push({ bool: { must_not: { exists: { field: 'clubs' } } } });
    } else if (clubs.includes('any')) {
      // 'any' means names in at least one club
      filter.push({ exists: { field: 'clubs' } });
    } else {
      // Regular club filter - match any of the specified clubs
      filter.push({ terms: { clubs: clubs } });
    }
  }

  // Exclude clubs filter - can be used standalone or with clubs='any'
  // Excludes names that are in ANY of the specified clubs
  if (excludeClubs && excludeClubs.length > 0) {
    filter.push({ bool: { must_not: { terms: { clubs: excludeClubs } } } });
  }

  // inAnyClub filter
  if (inAnyClub !== undefined) {
    const wantInClub = inAnyClub === 'true' || inAnyClub === true;
    if (wantInClub) {
      filter.push({ exists: { field: 'clubs' } });
    } else {
      filter.push({ bool: { must_not: { exists: { field: 'clubs' } } } });
    }
  }

  // Owner filter
  if (resolvedOwnerAddress) {
    filter.push({ term: { owner: resolvedOwnerAddress } });
  }

  // Unified status filter - supports single value or array (OR logic for multiple)
  if (status && status !== 'all') {
    const statuses = Array.isArray(status) ? status.filter(s => s !== 'all') : [status];

    if (statuses.length > 0) {
      filter.push({ exists: { field: 'expiry_date' } });

      // Helper to build range query for a single status
      const buildStatusRange = (s: string): any => {
        switch (s) {
          case 'registered':
            return { range: { expiry_date: { gt: 'now' } } };
          case 'grace':
            return { range: { expiry_date: { lte: 'now', gt: 'now-90d' } } };
          case 'premium':
            return { range: { expiry_date: { lte: 'now-90d', gt: 'now-111d' } } };
          case 'available':
            return { range: { expiry_date: { lte: 'now-111d' } } };
          default:
            return null;
        }
      };

      if (statuses.length === 1) {
        // Single status - add directly
        const rangeQuery = buildStatusRange(statuses[0]);
        if (rangeQuery) {
          filter.push(rangeQuery);
        }
      } else {
        // Multiple statuses - use bool.should (OR logic)
        const shouldClauses = statuses
          .map(buildStatusRange)
          .filter((q): q is any => q !== null);

        if (shouldClauses.length > 0) {
          filter.push({
            bool: {
              should: shouldClauses,
              minimum_should_match: 1
            }
          });
        }
      }
    }
  }

  // Legacy expiration filters
  if (isExpired !== undefined) {
    const wantExpired = isExpired === 'true' || isExpired === true;
    filter.push({ exists: { field: 'expiry_date' } });
    if (wantExpired) {
      filter.push({ range: { expiry_date: { lte: 'now' } } });
    } else {
      filter.push({ range: { expiry_date: { gt: 'now' } } });
    }
  }

  if (isGracePeriod !== undefined) {
    const wantGracePeriod = isGracePeriod === 'true' || isGracePeriod === true;
    filter.push({ exists: { field: 'expiry_date' } });
    if (wantGracePeriod) {
      filter.push({ range: { expiry_date: { lte: 'now', gt: 'now-90d' } } });
    } else {
      filter.push({
        bool: {
          should: [
            { range: { expiry_date: { gt: 'now' } } },
            { range: { expiry_date: { lte: 'now-90d' } } }
          ],
          minimum_should_match: 1
        }
      });
    }
  }

  if (isPremiumPeriod !== undefined) {
    const wantPremiumPeriod = isPremiumPeriod === 'true' || isPremiumPeriod === true;
    filter.push({ exists: { field: 'expiry_date' } });
    if (wantPremiumPeriod) {
      filter.push({ range: { expiry_date: { lte: 'now-90d', gt: 'now-111d' } } });
    } else {
      filter.push({
        bool: {
          should: [
            { range: { expiry_date: { gt: 'now-90d' } } },
            { range: { expiry_date: { lte: 'now-111d' } } }
          ],
          minimum_should_match: 1
        }
      });
    }
  }

  if (expiringWithinDays !== undefined) {
    const days = parseInt(String(expiringWithinDays));
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
  if (hasSales !== undefined) {
    filter.push({ term: { has_sales: hasSales === 'true' || hasSales === true } });
  }

  if (lastSoldAfter) {
    filter.push({
      range: {
        last_sale_date: { gte: lastSoldAfter },
      },
    });
  }

  if (lastSoldBefore) {
    filter.push({
      range: {
        last_sale_date: { lte: lastSoldBefore },
      },
    });
  }

  if (minDaysSinceLastSale !== undefined) {
    const days = parseInt(String(minDaysSinceLastSale));
    filter.push({
      range: {
        last_sale_date: { lte: `now-${days}d` },
      },
    });
  }

  if (maxDaysSinceLastSale !== undefined) {
    const days = parseInt(String(maxDaysSinceLastSale));
    filter.push({
      range: {
        last_sale_date: { gte: `now-${days}d` },
      },
    });
  }

  return { must, filter };
}

/**
 * Build Elasticsearch sort array from sort options
 */
export function buildESSort(options: {
  sortBy?: string;
  sortOrder?: string;
  q?: string;
  resolvedOwnerAddress?: string | null;
}): any[] {
  const { sortBy, sortOrder, q, resolvedOwnerAddress } = options;
  const sort: any[] = [];

  if (sortBy) {
    const order = sortOrder || 'desc';

    if (sortBy === 'price') {
      sort.push({
        'price_usd': {
          order,
          missing: '_last'
        }
      });
    } else if (sortBy === 'last_sale_price') {
      sort.push({
        'last_sale_price_usd': {
          order,
          missing: '_last'
        }
      });
    } else if (sortBy === 'offer') {
      sort.push({
        'highest_offer': {
          order,
          missing: '_last'
        }
      });
    } else if (sortBy === 'watchers_count') {
      sort.push({
        [sortBy]: {
          order,
          missing: '_last'
        }
      });
    } else if (sortBy === 'alphabetical') {
      sort.push({ 'name.keyword': { order } });
    } else {
      sort.push({ [sortBy]: { order } });
    }
  } else if (q) {
    sort.push({ _score: { order: 'desc' } });
    sort.push({ 'name.keyword': { order: 'asc' } });
  } else if (resolvedOwnerAddress) {
    sort.push({ 'name.keyword': { order: 'asc' } });
  } else {
    // Default sort: just _score to let ES naturally mix results
    // No secondary sort to avoid biasing toward listed or unlisted names
    sort.push({ _score: { order: 'desc' } });
  }

  return sort;
}

/**
 * Calculate minimum score based on query length
 */
export function calculateMinScore(q?: string): number | undefined {
  if (!q) return undefined;

  if (q.length <= 3) {
    return 1.0;
  } else if (q.length <= 5) {
    return 5.0;
  } else {
    return 20.0;
  }
}

/**
 * Build complete ES query object
 */
export function buildESQuery(options: ESFilterOptions & { from?: number }): {
  index: string;
  body: {
    query: { bool: { must: any[]; filter: any[] } };
    min_score?: number;
    from: number;
    size: number;
    sort: any[];
  };
} {
  const { must, filter } = buildESFilters(options);
  const sort = buildESSort({
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
    q: options.q,
    resolvedOwnerAddress: options.resolvedOwnerAddress,
  });
  const minScore = calculateMinScore(options.q);
  const from = options.from ?? ((options.page ?? 1) - 1) * (options.limit ?? 20);
  const size = options.limit ?? 20;

  return {
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
      size,
      sort,
    },
  };
}
