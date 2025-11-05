import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from './useAuth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api/v1';

// Market analytics response from GET /analytics/market
export interface MarketAnalytics {
  period: string;
  overview: {
    total_names: number;
    active_listings: number;
    active_offers: number;
    total_watchers: number;
    total_views: number;
  };
  volume: {
    sales_count: number;
    total_volume_wei: string;
    avg_sale_price_wei: string;
    max_sale_price_wei: string;
    min_sale_price_wei: string;
    unique_names_sold: number;
    unique_buyers: number;
    unique_sellers: number;
  };
  activity: {
    views: number;
    watchlist_adds: number;
    votes: number;
    offers: number;
    listings: number;
  };
}

// User personal stats from GET /analytics/user/me
export interface PersonalStats {
  total_views: number;
  total_votes_cast: number;
  upvotes_given: number;
  downvotes_given: number;
  watchlist_size: number;
  offers_made: number;
  total_offer_value_wei: string;
  avg_offer_wei: string;
  purchases_count: number;
  total_spent_wei: string;
  avg_purchase_wei: string;
  sales_count: number;
  total_revenue_wei: string;
  avg_sale_wei: string;
  active_listings: number;
}

// Price trends response from GET /analytics/price-trends
export interface PriceTrend {
  date: string;
  sales_count: number;
  total_volume_wei: string;
  avg_price_wei: string;
  median_price_wei: string;
}

// Volume metrics from GET /analytics/volume
export interface VolumeMetrics {
  period: string;
  interval: string;
  metrics: Array<{
    period_start: string;
    period_end: string;
    sales_count: number;
    total_volume_wei: string;
    avg_price_wei: string;
    unique_buyers: number;
    unique_sellers: number;
    unique_names: number;
  }>;
}

export interface AnalyticsResponse<T> {
  success: boolean;
  data: T;
  meta: {
    timestamp: string;
    version: string;
  };
}

/**
 * Fetch market overview statistics
 */
export function useMarketAnalytics(period: '24h' | '7d' | '30d' | '90d' | 'all' = '7d') {
  return useQuery<AnalyticsResponse<MarketAnalytics>>({
    queryKey: ['analytics', 'market', period],
    queryFn: async () => {
      const response = await axios.get(`${API_URL}/analytics/market`, {
        params: { period },
      });
      return response.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch price trends over time
 */
export function usePriceTrends(period: '24h' | '7d' | '30d' | '90d' | 'all' = '7d') {
  return useQuery<AnalyticsResponse<PriceTrend[]>>({
    queryKey: ['analytics', 'price-trends', period],
    queryFn: async () => {
      const response = await axios.get(`${API_URL}/analytics/price-trends`, {
        params: { period },
      });
      return response.data;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch volume metrics over time
 */
export function useVolumeMetrics(
  period: '24h' | '7d' | '30d' | '90d' = '7d',
  interval: 'hour' | 'day' | 'week' = 'day'
) {
  return useQuery<AnalyticsResponse<VolumeMetrics>>({
    queryKey: ['analytics', 'volume', period, interval],
    queryFn: async () => {
      const response = await axios.get(`${API_URL}/analytics/volume`, {
        params: { period, interval },
      });
      return response.data;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch personal statistics (requires authentication)
 */
export function usePersonalStats() {
  const { token, isAuthenticated } = useAuth();

  return useQuery<AnalyticsResponse<PersonalStats>>({
    queryKey: ['analytics', 'user', 'me'],
    queryFn: async () => {
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await axios.get(`${API_URL}/analytics/user/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.data;
    },
    enabled: isAuthenticated && !!token, // Only run if authenticated
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: false, // Don't retry if not authenticated
  });
}

/**
 * Fetch club analytics
 */
export function useClubAnalytics(club: string, period: '24h' | '7d' | '30d' | '90d' = '7d') {
  return useQuery<AnalyticsResponse<any>>({
    queryKey: ['analytics', 'clubs', club, period],
    queryFn: async () => {
      const response = await axios.get(`${API_URL}/analytics/clubs/${encodeURIComponent(club)}`, {
        params: { period },
      });
      return response.data;
    },
    enabled: !!club,
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
  });
}
