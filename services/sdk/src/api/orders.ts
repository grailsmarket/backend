/**
 * Orders API
 */

import type { HttpClient } from '../utils/http.js';
import type { Listing } from '../types/index.js';
import type { SeaportOrder } from '../seaport/types.js';

/**
 * Order type
 */
export type OrderType = 'listing' | 'offer' | 'collection_offer';

/**
 * Save order parameters
 */
export interface SaveOrderParams {
  /** Order type */
  type: OrderType;
  /** ENS token ID */
  token_id: string;
  /** Price in wei */
  price_wei: string;
  /** Currency address */
  currency_address?: string;
  /** Seaport order data (JSON string) */
  order_data: string;
  /** Order hash */
  order_hash: string;
  /** Seller address (for listings) */
  seller_address?: string;
  /** Buyer address (for offers) */
  buyer_address?: string;
  /** Traits metadata */
  traits?: Record<string, unknown>;
  /** Order status */
  status?: string;
  /** Order source */
  source?: string;
}

/**
 * Create order parameters
 */
export interface CreateOrderParams {
  /** ENS token ID */
  tokenId: string;
  /** Price in wei */
  price: string;
  /** Currency address (default: ETH) */
  currency?: string;
  /** Duration in days (default: 7) */
  duration?: number;
  /** Offerer address */
  offerer: string;
}

/**
 * Validate order response
 */
export interface ValidateOrderResponse {
  valid: boolean;
  errors: string[];
}

/**
 * Cancel order response
 */
export interface CancelOrderResponse {
  message: string;
  order: Listing;
}

/**
 * Bulk save listing
 */
export interface BulkListing {
  type: 'listing';
  token_id: string;
  price_wei: string;
  currency_address?: string;
  order_data: string;
  order_hash: string;
  seller_address: string;
  traits?: Record<string, unknown>;
  status?: string;
  source?: string;
}

/**
 * Bulk listing result
 */
export interface BulkListingResult {
  index: number;
  token_id: string;
  order_hash: string;
  status: 'created' | 'failed' | 'skipped';
  listing_id?: number;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Bulk save response
 */
export interface BulkSaveResponse {
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  results: BulkListingResult[];
}

/**
 * Orders API client
 */
export class OrdersAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Save an order (listing or offer) to the database
   *
   * @param params - Order parameters
   * @returns Created listing
   */
  async save(params: SaveOrderParams): Promise<Listing> {
    return this.http.post<Listing>('/orders', {
      type: params.type,
      token_id: params.token_id,
      price_wei: params.price_wei,
      currency_address: params.currency_address ?? '0x0000000000000000000000000000000000000000',
      order_data: params.order_data,
      order_hash: params.order_hash,
      seller_address: params.seller_address,
      buyer_address: params.buyer_address,
      traits: params.traits,
      status: params.status ?? 'active',
      source: params.source ?? 'grails',
    });
  }

  /**
   * Create a Seaport order structure
   *
   * @param params - Order creation parameters
   * @returns Seaport order structure
   */
  async create(params: CreateOrderParams): Promise<SeaportOrder> {
    return this.http.post<SeaportOrder>('/orders/create', {
      tokenId: params.tokenId,
      price: params.price,
      currency: params.currency ?? '0x0000000000000000000000000000000000000000',
      duration: params.duration ?? 7,
      offerer: params.offerer,
    });
  }

  /**
   * Validate a Seaport order
   *
   * @param orderData - Seaport order to validate
   * @returns Validation result
   */
  async validate(orderData: SeaportOrder): Promise<ValidateOrderResponse> {
    return this.http.post<ValidateOrderResponse>('/orders/validate', {
      orderData,
    });
  }

  /**
   * Get an order by ID or order hash
   *
   * @param idOrHash - Listing ID or order hash
   * @returns Order details
   * @throws {NotFoundError} if order not found
   */
  async get(idOrHash: string | number): Promise<Listing> {
    return this.http.get<Listing>(`/orders/${idOrHash}`);
  }

  /**
   * Cancel an order
   *
   * @param idOrHash - Listing ID or order hash
   * @returns Cancelled order info
   * @throws {NotFoundError} if order not found
   */
  async cancel(idOrHash: string | number): Promise<CancelOrderResponse> {
    return this.http.delete<CancelOrderResponse>(`/orders/${idOrHash}`);
  }

  /**
   * Bulk save listings (up to 500)
   *
   * @param listings - Array of listings to save
   * @returns Bulk save results
   */
  async bulkSave(listings: BulkListing[]): Promise<BulkSaveResponse> {
    if (listings.length > 500) {
      throw new Error('Maximum 500 listings per bulk request');
    }

    return this.http.post<BulkSaveResponse>('/orders/bulk', { listings });
  }
}
