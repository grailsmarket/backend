import { apiClient } from './client';
import { searchAPI, SearchParams as BaseSearchParams, SearchResult } from './search';
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

// Re-export SearchParams with showAll for backwards compatibility
export interface SearchParams extends Omit<BaseSearchParams, 'showListings'> {
  showAll?: boolean; // Kept for backwards compatibility (inverted to showListings internally)
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
    // Convert showAll (old) to showListings (new) - INVERTED LOGIC
    // Old: showAll=false (default) → only listings, showAll=true → all names
    // New: showListings=true → only listings, showListings=false (default) → all names
    const showListings = params.showAll !== undefined ? !params.showAll : true;

    // Use the new unified search API
    const searchParams: BaseSearchParams = {
      ...params,
      showListings,
    };

    const response = await searchAPI.search(searchParams);

    // Flatten search results: each ENS name with its listings becomes separate listing entries
    const flattenedListings: Listing[] = [];
    for (const result of response.results) {
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
            highest_offer_wei: result.highest_offer_wei,
            highest_offer_currency: result.highest_offer_currency,
            highest_offer_id: result.highest_offer_id,
          });
        }
      } else {
        // Name has no listings, but include it anyway (when showing all names)
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
          highest_offer_wei: result.highest_offer_wei,
          highest_offer_currency: result.highest_offer_currency,
          highest_offer_id: result.highest_offer_id,
        });
      }
    }

    return {
      listings: flattenedListings,
      pagination: response.pagination,
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

// Re-export searchAPI for convenience
export { searchAPI } from './search';