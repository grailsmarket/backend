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
    const response = await apiClient.get<APIResponse<{ listings: Listing[]; pagination: Pagination }>>('/listings/search', params);
    if (!response.success) {
      throw new Error(response.error?.message || 'Search failed');
    }
    return response.data!;
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