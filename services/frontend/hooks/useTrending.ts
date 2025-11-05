import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api/v1';

export interface TrendingName {
  id: number;
  name: string;
  token_id: string;
  owner: string;
  expiry_date: string | null;
  registration_date: string | null;
  last_sale_date: string | null;
  last_sale_price: string | null;
  last_sale_currency: string | null;
  last_sale_price_usd: number | null;
  metadata: any;
  clubs: string[] | null;
  has_numbers: boolean;
  has_emoji: boolean;
  listings: any[];
  upvotes: number;
  downvotes: number;
  net_score: number;
  user_vote?: number | null;
  watchers_count: number;
  highest_offer_wei: string | null;
  highest_offer_currency: string | null;
  highest_offer_id: number | null;
  view_count: number;
  trending_metrics?: {
    period: string;
    [key: string]: any;
  };
}

export interface TrendingResponse {
  success: boolean;
  data: {
    names: TrendingName[];
    meta: {
      period: string;
      type: string;
      limit: number;
      [key: string]: any;
    };
  };
  meta: {
    timestamp: string;
    version: string;
  };
}

export type TrendingType = 'composite' | 'views' | 'watchlist' | 'votes' | 'sales' | 'offers';
export type TrendingPeriod = '24h' | '7d';

/**
 * Fetch trending names
 */
export function useTrending(
  type: TrendingType = 'composite',
  period: TrendingPeriod = '24h',
  limit: number = 10,
  enabled: boolean = true
) {
  return useQuery<TrendingResponse>({
    queryKey: ['trending', type, period, limit],
    queryFn: async () => {
      const response = await axios.get(
        `${API_URL}/trending/${type}`,
        {
          params: { period, limit },
        }
      );
      return response.data;
    },
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch multiple trending types at once
 */
export function useMultipleTrending(
  types: TrendingType[],
  period: TrendingPeriod = '24h',
  limit: number = 10
) {
  const queries = types.map(type => useTrending(type, period, limit));

  return {
    data: queries.map(q => q.data),
    isLoading: queries.some(q => q.isLoading),
    error: queries.find(q => q.error)?.error,
    queries,
  };
}
