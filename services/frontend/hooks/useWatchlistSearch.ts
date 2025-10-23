'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';

interface SearchFilters {
  minPrice?: string;
  maxPrice?: string;
  minLength?: number;
  maxLength?: number;
  hasNumbers?: boolean;
  hasEmoji?: boolean;
  clubs?: string[];
  isExpired?: boolean;
  isGracePeriod?: boolean;
  isPremiumPeriod?: boolean;
  expiringWithinDays?: number;
  hasSales?: boolean;
  lastSoldAfter?: string;
  lastSoldBefore?: string;
  minDaysSinceLastSale?: number;
  maxDaysSinceLastSale?: number;
}

interface WatchlistSearchParams {
  q?: string;
  page?: number;
  limit?: number;
  filters?: SearchFilters;
}

interface WatchlistSearchResult {
  name: string;
  tokenId: string;
  price?: string;
  expiryDate?: string;
  ownerAddress?: string;
  isOnWatchlist?: boolean;
  watchlist?: {
    watchlistId: number;
    notifyOnSale: boolean;
    notifyOnOffer: boolean;
    notifyOnListing: boolean;
    notifyOnPriceChange: boolean;
    addedAt: string;
  };
  listing?: any;
}

interface WatchlistSearchResponse {
  success: boolean;
  data: {
    results: WatchlistSearchResult[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  };
}

async function searchWatchlist(
  token: string,
  params: WatchlistSearchParams
): Promise<WatchlistSearchResponse> {
  const { q = '*', page = 1, limit = 20, filters = {} } = params;

  // Build query string with bracket notation for filters
  const queryParams = new URLSearchParams();
  queryParams.append('q', q);
  queryParams.append('page', page.toString());
  queryParams.append('limit', limit.toString());

  // Add filters with bracket notation
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        // Array filters like clubs
        value.forEach((v) => {
          queryParams.append(`filters[${key}][]`, v.toString());
        });
      } else {
        queryParams.append(`filters[${key}]`, value.toString());
      }
    }
  });

  const url = `${process.env.NEXT_PUBLIC_API_URL}/watchlist/search?${queryParams.toString()}`;
  console.log('Fetching watchlist search:', url);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Watchlist search failed:', response.status, errorText);
    throw new Error('Failed to search watchlist');
  }

  const data = await response.json();
  console.log('Watchlist search results:', data);
  return data;
}

export function useWatchlistSearch(
  params: WatchlistSearchParams,
  enabled: boolean = true
) {
  const { token, isAuthenticated } = useAuth();

  const queryEnabled = enabled && isAuthenticated && !!token;

  console.log('useWatchlistSearch hook state:', {
    enabled,
    isAuthenticated,
    hasToken: !!token,
    queryEnabled,
    params,
  });

  return useQuery({
    queryKey: ['watchlistSearch', params],
    queryFn: () => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return searchWatchlist(token, params);
    },
    enabled: queryEnabled,
    staleTime: 30000,
    retry: 2,
  });
}
