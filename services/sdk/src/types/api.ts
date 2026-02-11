/**
 * API Response Types
 */

/**
 * Standard API response wrapper
 */
export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    timestamp: string;
    version?: string;
    requestId?: string;
  };
}

/**
 * Pagination metadata
 */
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  results: T[];
  pagination: Pagination;
}

/**
 * Paginated listings response
 */
export interface PaginatedListingsResponse<T> {
  listings: T[];
  pagination: Pagination;
}

/**
 * Paginated offers response
 */
export interface PaginatedOffersResponse<T> {
  offers: T[];
  pagination: Pagination;
}

/**
 * Paginated names response
 */
export interface PaginatedNamesResponse<T> {
  names: T[];
  pagination: Pagination;
}

/**
 * Bulk search stats
 */
export interface BulkSearchStats {
  inputTerms: number;
  matchedTerms: number;
}

/**
 * Bulk search response with stats
 */
export interface BulkSearchResponse<T> {
  results: T[];
  pagination: Pagination;
  stats?: BulkSearchStats;
}
