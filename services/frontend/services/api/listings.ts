import { apiClient } from './client';
import { APIResponse, Listing, Pagination } from '@/types';

export interface ListingsParams {
  page?: number;
  limit?: number;
  status?: 'active' | 'sold' | 'cancelled' | 'expired';
  seller?: string;
  minPrice?: string;
  maxPrice?: string;
  sort?: 'price' | 'created' | 'expiry' | 'name';
  order?: 'asc' | 'desc';
}

export interface SearchParams {
  q?: string;
  page?: number;
  limit?: number;
  minPrice?: string;
  maxPrice?: string;
  minLength?: number;
  maxLength?: number;
  hasEmoji?: boolean;
  hasNumbers?: boolean;
  showAll?: boolean;
  clubs?: string[];
  isExpired?: boolean;
  isGracePeriod?: boolean;
  isPremiumPeriod?: boolean;
  expiringWithinDays?: number;
  hasSales?: boolean;
  minDaysSinceLastSale?: number;
  maxDaysSinceLastSale?: number;
}

class ListingsAPI {
  async getListings(params?: ListingsParams): Promise<{ listings: Listing[]; pagination: Pagination }> {
    const response = await apiClient.get<APIResponse<{ listings: Listing[]; pagination: Pagination }>>('/listings', params);
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to fetch listings');
    }
    return response.data!;
  }

  async getListingByName(name: string): Promise<Listing[]> {
    const response = await apiClient.get<APIResponse<Listing[]>>(`/listings/name/${name}`);
    if (!response.success) {
      throw new Error(response.error?.message || 'Listing not found');
    }
    return response.data!;
  }

  async getListingById(id: string | number): Promise<Listing> {
    const response = await apiClient.get<APIResponse<Listing>>(`/listings/${id}`);
    if (!response.success) {
      throw new Error(response.error?.message || 'Listing not found');
    }
    return response.data!;
  }

  async searchListings(params: SearchParams): Promise<{ listings: Listing[]; pagination: Pagination }> {
    // Transform params to match backend API structure
    const queryParams: any = {
      q: params.q,
      page: params.page,
      limit: params.limit,
    };

    // Add filters as nested params
    if (params.minPrice !== undefined) queryParams['filters[minPrice]'] = params.minPrice;
    if (params.maxPrice !== undefined) queryParams['filters[maxPrice]'] = params.maxPrice;
    if (params.minLength !== undefined) queryParams['filters[minLength]'] = params.minLength;
    if (params.maxLength !== undefined) queryParams['filters[maxLength]'] = params.maxLength;
    if (params.hasEmoji !== undefined) queryParams['filters[hasEmoji]'] = params.hasEmoji;
    if (params.hasNumbers !== undefined) queryParams['filters[hasNumbers]'] = params.hasNumbers;
    if (params.showAll !== undefined) queryParams['filters[showAll]'] = params.showAll;

    // Handle clubs array - needs to be sent as filters[clubs][]
    if (params.clubs && params.clubs.length > 0) {
      queryParams['filters[clubs][]'] = params.clubs;
    }

    // Expiration filters
    if (params.isExpired !== undefined) queryParams['filters[isExpired]'] = params.isExpired;
    if (params.isGracePeriod !== undefined) queryParams['filters[isGracePeriod]'] = params.isGracePeriod;
    if (params.isPremiumPeriod !== undefined) queryParams['filters[isPremiumPeriod]'] = params.isPremiumPeriod;
    if (params.expiringWithinDays !== undefined) queryParams['filters[expiringWithinDays]'] = params.expiringWithinDays;

    // Sale history filters
    if (params.hasSales !== undefined) queryParams['filters[hasSales]'] = params.hasSales;
    if (params.minDaysSinceLastSale !== undefined) queryParams['filters[minDaysSinceLastSale]'] = params.minDaysSinceLastSale;
    if (params.maxDaysSinceLastSale !== undefined) queryParams['filters[maxDaysSinceLastSale]'] = params.maxDaysSinceLastSale;

    interface SearchResult {
      name: string;
      token_id: string;
      owner: string;
      expiry_date: string | null;
      last_sale_date: string | null;
      listings: Array<{
        id: number;
        price: string;
        currency_address: string;
        status: string;
        seller_address: string;
        order_hash: string;
        order_data: any;
        expires_at: string;
        created_at: string;
        source: string;
      }>;
    }

    const response = await apiClient.get<APIResponse<{ results: SearchResult[]; pagination: Pagination }>>('/listings/search', queryParams);
    if (!response.success) {
      throw new Error(response.error?.message || 'Search failed');
    }

    // Flatten search results: each ENS name with its listings becomes separate listing entries
    const flattenedListings: Listing[] = [];
    for (const result of response.data!.results) {
      if (result.listings && result.listings.length > 0) {
        // Map each nested listing to a flat Listing object
        for (const listing of result.listings) {
          flattenedListings.push({
            id: listing.id,
            ens_name_id: 0, // Not provided in search response
            name: result.name, // Use 'name' from parent result
            token_id: result.token_id,
            seller_address: listing.seller_address,
            price_wei: listing.price,
            currency_address: listing.currency_address,
            order_hash: listing.order_hash,
            order_data: listing.order_data,
            status: listing.status as 'active' | 'sold' | 'cancelled' | 'expired',
            source: listing.source as 'grails' | 'opensea',
            created_at: listing.created_at,
            updated_at: listing.created_at,
            expires_at: listing.expires_at,
            current_owner: result.owner,
            name_expiry_date: result.expiry_date,
            last_sale_date: result.last_sale_date,
          });
        }
      } else {
        // Name has no listings, but include it anyway (for showAll mode)
        flattenedListings.push({
          id: 0,
          ens_name_id: 0,
          name: result.name,
          token_id: result.token_id,
          seller_address: '',
          price_wei: '0',
          currency_address: '0x0000000000000000000000000000000000000000',
          order_hash: '',
          order_data: {},
          status: 'expired' as 'active' | 'sold' | 'cancelled' | 'expired',
          source: undefined,
          created_at: '',
          updated_at: '',
          expires_at: undefined,
          current_owner: result.owner,
          name_expiry_date: result.expiry_date,
          last_sale_date: result.last_sale_date,
        });
      }
    }

    return {
      listings: flattenedListings,
      pagination: response.data!.pagination,
    };
  }

  async createListing(data: {
    ensNameId: number;
    sellerAddress: string;
    priceWei: string;
    currencyAddress?: string;
    orderData: any;
    expiresAt?: string;
  }): Promise<Listing> {
    const response = await apiClient.post<APIResponse<Listing>>('/listings', data);
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to create listing');
    }
    return response.data!;
  }

  async updateListing(id: string | number, data: {
    priceWei?: string;
    expiresAt?: string;
  }): Promise<Listing> {
    const response = await apiClient.put<APIResponse<Listing>>(`/listings/${id}`, data);
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to update listing');
    }
    return response.data!;
  }

  async cancelListing(id: string | number): Promise<void> {
    const response = await apiClient.delete<APIResponse>(`/listings/${id}`);
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to cancel listing');
    }
  }
}

export const listingsAPI = new ListingsAPI();