import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api/v1';

export interface RecommendedName {
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
  reason?: string;
  score?: number;
}

export interface RecommendationsResponse {
  success: boolean;
  data: {
    names: RecommendedName[];
    meta: {
      source: string;
      limit: number;
      [key: string]: any;
    };
  };
  meta: {
    timestamp: string;
    version: string;
  };
}

/**
 * Fetch recommendations based on collectors who also viewed this name
 */
export function useAlsoViewed(name: string, limit: number = 6) {
  return useQuery<RecommendationsResponse>({
    queryKey: ['recommendations', 'also-viewed', name, limit],
    queryFn: async () => {
      const response = await axios.get(
        `${API_URL}/recommendations/also-viewed`,
        {
          params: { name, limit },
        }
      );
      return response.data;
    },
    enabled: !!name,
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch recommendations based on user's watchlist
 */
export function useSimilarToWatchlist(limit: number = 10) {
  return useQuery<RecommendationsResponse>({
    queryKey: ['recommendations', 'similar-to-watchlist', limit],
    queryFn: async () => {
      const response = await axios.get(
        `${API_URL}/recommendations/similar-to-watchlist`,
        {
          params: { limit },
        }
      );
      return response.data;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch recommendations based on user's voting patterns
 */
export function useRecommendationsByVotes(limit: number = 10) {
  return useQuery<RecommendationsResponse>({
    queryKey: ['recommendations', 'by-votes', limit],
    queryFn: async () => {
      const response = await axios.get(
        `${API_URL}/recommendations/by-votes`,
        {
          params: { limit },
        }
      );
      return response.data;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
  });
}
