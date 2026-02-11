/**
 * Names API
 */

import type { HttpClient } from '../utils/http.js';
import type { ENSName, SearchResult, NamesFilters } from '../types/index.js';
import type { PaginatedNamesResponse } from '../types/api.js';

/**
 * Name metadata
 */
export interface NameMetadata {
  name: string;
  metadata: Record<string, unknown>;
  source: 'database' | 'graph';
}

/**
 * Names API client
 */
export class NamesAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get paginated list of ENS names
   *
   * @param filters - Optional filters and pagination
   * @returns Paginated list of names
   */
  async list(filters?: NamesFilters): Promise<PaginatedNamesResponse<ENSName>> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page,
      limit: filters?.limit,
      owner: filters?.owner,
      status: filters?.status,
      sort: filters?.sort,
      order: filters?.order,
    };

    return this.http.get<PaginatedNamesResponse<ENSName>>('/names', params);
  }

  /**
   * Get a single ENS name with full details
   *
   * @param name - ENS name (e.g., "vitalik.eth")
   * @returns Name details with listings, votes, etc.
   * @throws {NotFoundError} if name not found
   */
  async get(name: string): Promise<SearchResult> {
    return this.http.get<SearchResult>(`/names/${encodeURIComponent(name)}`);
  }

  /**
   * Get fresh metadata for an ENS name
   *
   * Always fetches from The Graph, bypassing cache
   *
   * @param name - ENS name (e.g., "vitalik.eth")
   * @returns Name metadata
   * @throws {NotFoundError} if name not found
   */
  async getMetadata(name: string): Promise<NameMetadata> {
    return this.http.get<NameMetadata>(`/names/${encodeURIComponent(name)}/metadata`);
  }

  /**
   * Get transaction history for an ENS name
   *
   * @param name - ENS name
   * @param options - Pagination options
   * @returns Transaction history
   */
  async getHistory(
    name: string,
    options?: { page?: number; limit?: number }
  ): Promise<{
    transactions: Array<{
      transaction_hash: string;
      block_number: number;
      from_address: string;
      to_address: string;
      price_wei: string | null;
      transaction_type: 'sale' | 'transfer' | 'registration' | 'renewal';
      timestamp: string;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  }> {
    return this.http.get(`/names/${encodeURIComponent(name)}/history`, {
      page: options?.page,
      limit: options?.limit,
    });
  }
}
