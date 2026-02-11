/**
 * Offers API
 */

import type { HttpClient } from '../utils/http.js';
import type { Offer, OfferFilters } from '../types/index.js';
import type { PaginatedOffersResponse } from '../types/api.js';

/**
 * Create offer parameters
 */
export interface CreateOfferParams {
  /** ENS name ID */
  ensNameId: number;
  /** Buyer address */
  buyerAddress: string;
  /** Offer amount in wei */
  offerAmountWei: string;
  /** Currency address (default: WETH) */
  currencyAddress?: string;
  /** Seaport order data */
  orderData: Record<string, unknown>;
  /** Expiration time (ISO string) */
  expiresAt?: string;
}

/**
 * Update offer parameters
 */
export interface UpdateOfferParams {
  /** New offer amount in wei */
  offerAmountWei?: string;
  /** New status */
  status?: 'pending' | 'accepted' | 'rejected' | 'expired' | 'unfunded';
}

/**
 * Cancel offer response
 */
export interface CancelOfferResponse {
  /** Cancelled offer ID */
  id: number;
  /** Confirmation message */
  message: string;
}

/**
 * Offers API client
 */
export class OffersAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get offers for a specific ENS name
   *
   * @param name - ENS name (e.g., "vitalik.eth")
   * @param filters - Optional filters and pagination
   * @returns Paginated list of offers
   */
  async getByName(
    name: string,
    filters?: OfferFilters
  ): Promise<PaginatedOffersResponse<Offer>> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page,
      limit: filters?.limit,
      status: filters?.status,
    };

    return this.http.get<PaginatedOffersResponse<Offer>>(
      `/offers/name/${encodeURIComponent(name)}`,
      params
    );
  }

  /**
   * Get offers made by a specific buyer
   *
   * @param address - Buyer address
   * @param filters - Optional filters and pagination
   * @returns Paginated list of offers
   */
  async getByBuyer(
    address: string,
    filters?: OfferFilters
  ): Promise<PaginatedOffersResponse<Offer>> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page,
      limit: filters?.limit,
      status: filters?.status,
    };

    return this.http.get<PaginatedOffersResponse<Offer>>(
      `/offers/buyer/${address.toLowerCase()}`,
      params
    );
  }

  /**
   * Get offers received by an owner (offers on names they own)
   *
   * @param address - Owner address
   * @param filters - Optional filters and pagination
   * @returns Paginated list of offers
   */
  async getByOwner(
    address: string,
    filters?: OfferFilters
  ): Promise<PaginatedOffersResponse<Offer>> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: filters?.page,
      limit: filters?.limit,
      status: filters?.status,
    };

    return this.http.get<PaginatedOffersResponse<Offer>>(
      `/offers/owner/${address.toLowerCase()}`,
      params
    );
  }

  /**
   * Get a single offer by ID
   *
   * @param id - Offer ID
   * @returns Offer details
   * @throws {NotFoundError} if offer not found
   */
  async get(id: number): Promise<Offer> {
    return this.http.get<Offer>(`/offers/${id}`);
  }

  /**
   * Create a new offer
   *
   * @param params - Offer parameters
   * @returns Created offer
   */
  async create(params: CreateOfferParams): Promise<Offer> {
    return this.http.post<Offer>('/offers', {
      ensNameId: params.ensNameId,
      buyerAddress: params.buyerAddress,
      offerAmountWei: params.offerAmountWei,
      currencyAddress: params.currencyAddress,
      orderData: params.orderData,
      expiresAt: params.expiresAt,
    });
  }

  /**
   * Update an existing offer
   *
   * @param id - Offer ID
   * @param params - Update parameters
   * @returns Updated offer
   * @throws {NotFoundError} if offer not found
   */
  async update(id: number, params: UpdateOfferParams): Promise<Offer> {
    return this.http.put<Offer>(`/offers/${id}`, params);
  }

  /**
   * Cancel an offer
   *
   * @param id - Offer ID
   * @returns Cancelled offer info
   * @throws {NotFoundError} if offer not found
   */
  async cancel(id: number): Promise<CancelOfferResponse> {
    return this.http.delete<CancelOfferResponse>(`/offers/${id}`);
  }
}
