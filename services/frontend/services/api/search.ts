import { apiClient } from './client';
import { APIResponse, Pagination } from '@/types';

export interface SearchParams {
  q?: string;
  page?: number;
  limit?: number;
  sortBy?: 'price' | 'expiry_date' | 'registration_date' | 'last_sale_date' | 'last_sale_price' | 'character_count' | 'watchers_count';
  sortOrder?: 'asc' | 'desc';
  minPrice?: string;
  maxPrice?: string;
  minLength?: number;
  maxLength?: number;
  hasEmoji?: boolean;
  hasNumbers?: boolean;
  showListings?: boolean; // New flag: true = only names with listings, false/undefined = all names
  clubs?: string[];
  owner?: string; // Filter by owner address or ENS name
  isExpired?: boolean;
  isGracePeriod?: boolean;
  isPremiumPeriod?: boolean;
  expiringWithinDays?: number;
  hasSales?: boolean;
  minDaysSinceLastSale?: number;
  maxDaysSinceLastSale?: number;
}

export interface SearchResult {
  name: string;
  token_id: string;
  owner: string;
  expiry_date: string | null;
  registration_date: string | null;
  last_sale_date: string | null;
  metadata: any;
  clubs: string[] | null;
  has_numbers: boolean;
  has_emoji: boolean;
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
  upvotes: number;
  downvotes: number;
  net_score: number;
  watchers_count: number;
}

class SearchAPI {
  async search(params: SearchParams): Promise<{ results: SearchResult[]; pagination: Pagination }> {
    // Transform params to match backend API structure
    const queryParams: any = {
      q: params.q || '',
      page: params.page,
      limit: params.limit,
    };

    // Add sort params
    if (params.sortBy !== undefined) queryParams['sortBy'] = params.sortBy;
    if (params.sortOrder !== undefined) queryParams['sortOrder'] = params.sortOrder;

    // Add filters as nested params
    if (params.minPrice !== undefined) queryParams['filters[minPrice]'] = params.minPrice;
    if (params.maxPrice !== undefined) queryParams['filters[maxPrice]'] = params.maxPrice;
    if (params.minLength !== undefined) queryParams['filters[minLength]'] = params.minLength;
    if (params.maxLength !== undefined) queryParams['filters[maxLength]'] = params.maxLength;
    if (params.hasEmoji !== undefined) queryParams['filters[hasEmoji]'] = params.hasEmoji;
    if (params.hasNumbers !== undefined) queryParams['filters[hasNumbers]'] = params.hasNumbers;
    if (params.showListings !== undefined) queryParams['filters[showListings]'] = params.showListings;
    if (params.owner !== undefined) queryParams['filters[owner]'] = params.owner;

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

    const response = await apiClient.get<APIResponse<{ results: SearchResult[]; pagination: Pagination }>>('/search', queryParams);
    if (!response.success) {
      throw new Error(response.error?.message || 'Search failed');
    }

    return response.data!;
  }
}

export const searchAPI = new SearchAPI();
