/**
 * Search API
 */

import type { HttpClient } from '../utils/http.js';
import type {
  SearchResult,
  SearchFilters,
  BulkExactSearchOptions,
  BulkFiltersSearchOptions,
} from '../types/index.js';
import type { PaginatedResponse, BulkSearchResponse } from '../types/api.js';

/**
 * Build query string from search filters
 */
function buildFilterParams(filters: SearchFilters): Record<string, string | number | boolean | undefined> {
  const params: Record<string, string | number | boolean | undefined> = {};

  // Simple params
  if (filters.q !== undefined) params.q = filters.q;
  if (filters.page !== undefined) params.page = filters.page;
  if (filters.limit !== undefined) params.limit = filters.limit;
  if (filters.sortBy !== undefined) params.sortBy = filters.sortBy;
  if (filters.sortOrder !== undefined) params.sortOrder = filters.sortOrder;

  // Filter bracket notation
  const filterKeys: (keyof SearchFilters)[] = [
    'minPrice', 'maxPrice', 'minOffer', 'maxOffer',
    'minLength', 'maxLength',
    'minWatchersCount', 'maxWatchersCount',
    'minViewCount', 'maxViewCount',
    'minClubsCount', 'maxClubsCount',
    'hasNumbers', 'hasEmoji',
    'digits', 'letters', 'emoji', 'repeatingChars',
    'contains', 'startsWith', 'endsWith',
    'doesNotContain', 'doesNotStartWith', 'doesNotEndWith',
    'listed', 'hasOffer', 'showListings', 'showUnlisted',
    'marketplace', 'inAnyClub',
    'isExpired', 'isGracePeriod', 'isPremiumPeriod',
    'expiringWithinDays', 'includeExpired',
    'hasSales', 'lastSoldAfter', 'lastSoldBefore',
    'minDaysSinceLastSale', 'maxDaysSinceLastSale',
    'owner',
  ];

  for (const key of filterKeys) {
    const value = filters[key];
    if (value !== undefined) {
      params[`filters[${key}]`] = value as string | number | boolean;
    }
  }

  // Handle arrays (clubs, excludeClubs, status)
  if (filters.clubs && filters.clubs.length > 0) {
    filters.clubs.forEach((club, i) => {
      params[`filters[clubs][${i}]`] = club;
    });
  }

  if (filters.excludeClubs && filters.excludeClubs.length > 0) {
    filters.excludeClubs.forEach((club, i) => {
      params[`filters[excludeClubs][${i}]`] = club;
    });
  }

  if (filters.status !== undefined) {
    if (Array.isArray(filters.status)) {
      params[`filters[status]`] = filters.status.join(',');
    } else {
      params[`filters[status]`] = filters.status;
    }
  }

  return params;
}

/**
 * Search API client
 */
export class SearchAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Search for ENS names with filters
   *
   * @param filters - Search filters and pagination
   * @returns Paginated search results
   *
   * @example
   * ```ts
   * // Search for 3-letter names with active listings
   * const results = await grails.search.search({
   *   minLength: 3,
   *   maxLength: 3,
   *   showListings: true,
   *   sortBy: 'price',
   *   sortOrder: 'asc',
   * });
   * ```
   */
  async search(filters?: SearchFilters): Promise<PaginatedResponse<SearchResult>> {
    const params = filters ? buildFilterParams(filters) : {};
    return this.http.get<PaginatedResponse<SearchResult>>('/search', params);
  }

  /**
   * Bulk exact search for multiple terms
   *
   * Returns results in the same order as input terms.
   * For terms not found, returns placeholder objects with id=0.
   *
   * @param options - Search options
   * @returns Paginated search results
   *
   * @example
   * ```ts
   * const results = await grails.search.bulkExact({
   *   terms: ['vitalik', 'ethereum', 'wallet'],
   *   page: 1,
   *   limit: 20,
   * });
   * ```
   */
  async bulkExact(options: BulkExactSearchOptions): Promise<PaginatedResponse<SearchResult>> {
    return this.http.post<PaginatedResponse<SearchResult>>('/search/bulk', {
      terms: options.terms,
      page: options.page ?? 1,
      limit: options.limit ?? 20,
    });
  }

  /**
   * Bulk search with filters
   *
   * Searches for specific terms AND applies filters.
   * Only returns names that match both the terms AND the filters.
   * Does not return placeholder objects for filtered-out terms.
   *
   * @param options - Search options with filters
   * @returns Paginated search results with stats
   *
   * @example
   * ```ts
   * const results = await grails.search.bulkFilters({
   *   terms: ['vitalik', 'ethereum', 'wallet'],
   *   showListings: true,
   *   minPrice: '1000000000000000000', // 1 ETH
   * });
   *
   * console.log(results.stats.inputTerms);   // 3
   * console.log(results.stats.matchedTerms); // Number matching filters
   * ```
   */
  async bulkFilters(options: BulkFiltersSearchOptions): Promise<BulkSearchResponse<SearchResult>> {
    const { terms, ...filters } = options;

    // Build filters object for request body
    const requestFilters: Record<string, unknown> = {};

    const filterKeys: (keyof SearchFilters)[] = [
      'minPrice', 'maxPrice', 'minOffer', 'maxOffer',
      'minLength', 'maxLength',
      'minWatchersCount', 'maxWatchersCount',
      'minViewCount', 'maxViewCount',
      'minClubsCount', 'maxClubsCount',
      'hasNumbers', 'hasEmoji',
      'digits', 'letters', 'emoji', 'repeatingChars',
      'contains', 'startsWith', 'endsWith',
      'doesNotContain', 'doesNotStartWith', 'doesNotEndWith',
      'listed', 'hasOffer', 'showListings', 'showUnlisted',
      'marketplace', 'clubs', 'excludeClubs', 'inAnyClub',
      'status', 'isExpired', 'isGracePeriod', 'isPremiumPeriod',
      'expiringWithinDays', 'includeExpired',
      'hasSales', 'lastSoldAfter', 'lastSoldBefore',
      'minDaysSinceLastSale', 'maxDaysSinceLastSale',
      'owner',
    ];

    for (const key of filterKeys) {
      const value = (filters as Record<string, unknown>)[key];
      if (value !== undefined) {
        requestFilters[key] = value;
      }
    }

    return this.http.post<BulkSearchResponse<SearchResult>>('/search/bulk-filters', {
      terms,
      page: filters.page ?? 1,
      limit: filters.limit ?? 20,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      filters: Object.keys(requestFilters).length > 0 ? requestFilters : undefined,
    });
  }

  /**
   * Export search results as CSV
   *
   * Requires authentication.
   *
   * @param filters - Search filters
   * @param filename - Optional filename (without extension)
   * @returns CSV string
   */
  async export(filters?: SearchFilters, filename?: string): Promise<string> {
    const params = filters ? buildFilterParams(filters) : {};
    params.export = 'true';
    if (filename) {
      params.filename = filename;
    }

    // Make raw request to get CSV string
    const url = this.buildExportUrl(params);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Export failed: ${response.statusText}`);
    }

    return response.text();
  }

  private buildExportUrl(params: Record<string, string | number | boolean | undefined>): string {
    // This is a simplified version - in practice you'd use the http client
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    }
    return `/api/v1/search?${searchParams.toString()}`;
  }
}
