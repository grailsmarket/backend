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
 * A name found by one of its ENS NFTs (see NamesAPI.getByToken)
 */
export interface NameByToken {
  name: string;
  ens_version: 1 | 2;
  /**
   * The contract and id asked for. `matched_by` says whether the id matched as a token id or as
   * the name's namehash; `is_current` is false for a namehash (except on the NameWrapper) or an
   * outdated token id.
   */
  token: { contract: string; token_id: string; matched_by: 'token_id' | 'namehash'; is_current: boolean };
  /** The contract and token id the name trades as now. */
  current_token: { contract: string; token_id: string };
  owner: string;
  expiry_date: string | null;
  registration_date: string | null;
  resolver_address: string | null;
  /** Cached text, address and contenthash records */
  metadata: Record<string, unknown>;
  metadata_updated_at: string | null;
  /** With `include: ['avatar']`: a fetchable avatar URL, null when unset */
  avatar?: string | null;
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
   * Find a name and its records by NFT: v1 BaseRegistrar (labelhash), v1 NameWrapper
   * (namehash) or ENSv2 ETHRegistry (any version of the token id). The name's namehash also
   * works in place of the token id on any of the three.
   *
   * @param contract - Token contract address
   * @param tokenId - Token id or namehash, decimal or 0x hex
   * @param options - `include: ['avatar']` adds the resolved avatar URL
   * @throws {NotFoundError} if the contract isn't an ENS NFT contract or no name has this token
   */
  async getByToken(
    contract: string,
    tokenId: string | bigint,
    options?: { include?: Array<'avatar'> }
  ): Promise<NameByToken> {
    return this.http.get<NameByToken>(
      `/names/by-token/${encodeURIComponent(contract)}/${encodeURIComponent(tokenId.toString())}`,
      { include: options?.include?.length ? options.include.join(',') : undefined }
    );
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
