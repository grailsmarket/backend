/**
 * Listings API
 */

import type { HttpClient } from '../utils/http.js';
import type { Listing, ListingFilters } from '../types/index.js';
import type { PaginatedListingsResponse } from '../types/api.js';

/**
 * Create listing parameters
 */
export interface CreateListingParams {
  /** ENS name ID */
  ensNameId: number;
  /** Seller address */
  sellerAddress: string;
  /** Price in wei */
  priceWei: string;
  /** Currency address (default: ETH) */
  currencyAddress?: string;
  /** Seaport order data */
  orderData: Record<string, unknown>;
  /** Expiration time (ISO string) */
  expiresAt?: string;
}

/**
 * Update listing parameters
 */
export interface UpdateListingParams {
  /** New price in wei */
  priceWei?: string;
  /** New expiration time (ISO string) */
  expiresAt?: string;
}

/**
 * Cancel listing response
 */
export interface CancelListingResponse {
  message: string;
  listing: Listing;
}

/**
 * Listings API client
 */
export class ListingsAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get paginated listings
   *
   * @param filters - Optional filters and pagination
   * @returns Paginated list of listings
   */
  async list(filters?: ListingFilters & { page?: number; limit?: number }): Promise<PaginatedListingsResponse<Listing>> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page,
      limit: filters?.limit,
      status: filters?.status,
      seller: filters?.seller,
      minPrice: filters?.minPrice,
      maxPrice: filters?.maxPrice,
      sort: filters?.sort,
      order: filters?.order,
    };

    return this.http.get<PaginatedListingsResponse<Listing>>('/listings', params);
  }

  /**
   * Get a single listing by ID
   *
   * @param id - Listing ID
   * @returns Listing details
   * @throws {NotFoundError} if listing not found
   */
  async get(id: number): Promise<Listing> {
    return this.http.get<Listing>(`/listings/${id}`);
  }

  /**
   * Get listings for a specific ENS name
   *
   * @param name - ENS name (e.g., "vitalik.eth")
   * @returns Array of active listings for the name
   * @throws {NotFoundError} if no listings found
   */
  async getByName(name: string): Promise<Listing[]> {
    return this.http.get<Listing[]>(`/listings/name/${encodeURIComponent(name)}`);
  }

  /**
   * Create a new listing
   *
   * @param params - Listing parameters
   * @returns Created listing
   */
  async create(params: CreateListingParams): Promise<Listing> {
    return this.http.post<Listing>('/listings', {
      ensNameId: params.ensNameId,
      sellerAddress: params.sellerAddress,
      priceWei: params.priceWei,
      currencyAddress: params.currencyAddress,
      orderData: params.orderData,
      expiresAt: params.expiresAt,
    });
  }

  /**
   * Update an existing listing
   *
   * @param id - Listing ID
   * @param params - Update parameters
   * @returns Updated listing
   * @throws {NotFoundError} if listing not found
   */
  async update(id: number, params: UpdateListingParams): Promise<Listing> {
    return this.http.put<Listing>(`/listings/${id}`, params);
  }

  /**
   * Cancel a listing
   *
   * @param id - Listing ID
   * @returns Cancelled listing info
   * @throws {NotFoundError} if listing not found
   */
  async cancel(id: number): Promise<CancelListingResponse> {
    return this.http.delete<CancelListingResponse>(`/listings/${id}`);
  }
}
