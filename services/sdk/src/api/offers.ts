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
 * Bulk offer item (for shotgun mode)
 */
export interface BulkOfferItem {
  ensNameId: number;
  offerAmountWei: string;
  orderData: Record<string, unknown>;
  orderHash?: string;
  signature: string;
}

/**
 * Bulk offer creation params
 */
export interface CreateBulkOffersParams {
  offers: BulkOfferItem[];
  buyerAddress: string;
  currencyAddress?: string;
  expiresAt?: string;
  treeHeight: number;
  merkleRoot?: string;
}

/**
 * Bulk offer group
 */
export interface BulkOfferGroup {
  id: number;
  buyer_address: string;
  offer_count: number;
  tree_height: number;
  merkle_root: string | null;
  total_amount_wei: string;
  currency_address: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
}

/**
 * Bulk offer response
 */
export interface BulkOfferResponse {
  groupId: number;
  totalOffers: number;
  created: number;
  failed: number;
  results: Array<{ index: number; offerId: number; ensNameId: number }>;
  errors?: Array<{ index: number; ensNameId: number; error: string }>;
}

/**
 * Criteria offer creation params (pick-one mode)
 */
export interface CreateCriteriaOfferParams {
  buyerAddress: string;
  offerAmountWei: string;
  tokenIds: string[];
  merkleRoot: string;
  orderData: Record<string, unknown>;
  orderHash?: string;
  signature: string;
  currencyAddress?: string;
  expiresAt?: string;
}

/**
 * Criteria offer response
 */
export interface CriteriaOfferResponse {
  offerId: number;
  merkleRoot: string;
  tokenCount: number;
}

/**
 * Offer limits
 */
export interface OfferLimits {
  max_bulk_offers_per_request: number;
  max_active_offers_per_user: number;
  min_offer_amount_wei: string;
  min_offer_floor_pct: number;
  max_bulk_offer_names: number;
  max_criteria_offer_names: number;
  bulk_offers_enabled: boolean;
}

/**
 * Edit offer params
 */
export interface EditOfferParams {
  offerAmountWei: string;
  orderData: Record<string, unknown>;
  orderHash?: string;
  signature: string;
  expiresAt?: string;
}

/**
 * Bulk edit params
 */
export interface BulkEditParams {
  cancelOfferIds: number[];
  offers: BulkOfferItem[];
  buyerAddress: string;
  currencyAddress?: string;
  expiresAt?: string;
  treeHeight: number;
  merkleRoot?: string;
}

/**
 * Offers API client
 */
export class OffersAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get offers for a specific ENS name
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
   */
  async get(id: number): Promise<Offer> {
    return this.http.get<Offer>(`/offers/${id}`);
  }

  /**
   * Create a new offer
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
   */
  async update(id: number, params: UpdateOfferParams): Promise<Offer> {
    return this.http.put<Offer>(`/offers/${id}`, params);
  }

  /**
   * Cancel an offer
   */
  async cancel(id: number): Promise<CancelOfferResponse> {
    return this.http.delete<CancelOfferResponse>(`/offers/${id}`);
  }

  // ========================
  // Bulk Offers (Mode 1: Shotgun)
  // ========================

  /**
   * Create bulk offers (up to 500)
   */
  async createBulk(params: CreateBulkOffersParams): Promise<BulkOfferResponse> {
    return this.http.post<BulkOfferResponse>('/offers/bulk', params);
  }

  /**
   * Cancel all offers in a bulk group
   */
  async cancelBulk(groupId: number): Promise<{ groupId: number; cancelledCount: number }> {
    return this.http.delete(`/offers/bulk/${groupId}`);
  }

  /**
   * Get a bulk offer group and its offers
   */
  async getBulkGroup(groupId: number): Promise<{ group: BulkOfferGroup; offers: Offer[] }> {
    return this.http.get(`/offers/bulk/${groupId}`);
  }

  /**
   * List buyer's bulk offer groups
   */
  async getBulkGroups(
    address: string,
    filters?: { page?: number; limit?: number; status?: string }
  ): Promise<{ groups: BulkOfferGroup[]; pagination: any }> {
    return this.http.get(`/offers/bulk/buyer/${address.toLowerCase()}`, filters);
  }

  // ========================
  // Criteria Offers (Mode 2: Pick-One)
  // ========================

  /**
   * Create a criteria-based offer
   */
  async createCriteriaOffer(params: CreateCriteriaOfferParams): Promise<CriteriaOfferResponse> {
    return this.http.post<CriteriaOfferResponse>('/offers/criteria', params);
  }

  /**
   * Cancel a criteria offer
   */
  async cancelCriteriaOffer(id: number): Promise<{ offerId: number; cancelled: boolean }> {
    return this.http.delete(`/offers/criteria/${id}`);
  }

  /**
   * Get merkle proof for fulfilling a criteria offer
   */
  async getCriteriaProof(
    offerId: number,
    tokenId: string
  ): Promise<{ proof: string[]; merkleRoot: string; tokenId: string }> {
    return this.http.get(`/offers/criteria/${offerId}/proof/${tokenId}`);
  }

  // ========================
  // Shared
  // ========================

  /**
   * Edit an offer (cancel old + create new)
   */
  async edit(id: number, params: EditOfferParams): Promise<{ cancelledOfferId: number; newOffer: Offer }> {
    return this.http.put(`/offers/${id}/edit`, params);
  }

  /**
   * Bulk edit offers
   */
  async editBulk(params: BulkEditParams): Promise<BulkOfferResponse> {
    return this.http.put<BulkOfferResponse>('/offers/bulk/edit', params);
  }

  /**
   * Get current offer limits
   */
  async getLimits(): Promise<OfferLimits> {
    return this.http.get<OfferLimits>('/offers/limits');
  }
}
