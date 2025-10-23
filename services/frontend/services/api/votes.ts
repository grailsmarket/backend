import { apiClient } from './client';
import { APIResponse } from '@/types';

export interface VoteStats {
  ensName: string;
  upvotes: number;
  downvotes: number;
  netScore: number;
  userVote?: number | null;
}

export interface CastVoteResponse {
  vote: {
    id: number;
    ensNameId: number;
    userId: number;
    vote: number;
    createdAt: string;
    updatedAt: string;
  };
  voteCounts: {
    upvotes: number;
    downvotes: number;
    netScore: number;
  };
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  tokenId: string;
  ownerAddress: string;
  upvotes: number;
  downvotes: number;
  netScore: number;
  activeListing?: {
    id: number;
    price_wei: string;
    currency_address: string;
    status: string;
    source: string;
  };
}

export interface LeaderboardParams {
  page?: number;
  limit?: number;
  sortBy?: 'upvotes' | 'netScore' | 'downvotes';
}

class VotesAPI {
  /**
   * Cast or update a vote for an ENS name
   */
  async castVote(ensName: string, vote: number, token: string): Promise<CastVoteResponse> {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/votes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ ensName, vote }),
    });

    const data: APIResponse<CastVoteResponse> = await response.json();

    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to cast vote');
    }

    return data.data!;
  }

  /**
   * Get vote statistics for an ENS name
   */
  async getVoteStats(ensName: string, token?: string): Promise<VoteStats> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/votes/${ensName}`, {
      method: 'GET',
      headers,
    });

    const data: APIResponse<VoteStats> = await response.json();

    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to fetch vote stats');
    }

    return data.data!;
  }

  /**
   * Get leaderboard of top voted names
   */
  async getLeaderboard(params?: LeaderboardParams): Promise<{
    leaderboard: LeaderboardEntry[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  }> {
    const queryParams = new URLSearchParams();

    if (params?.page) queryParams.append('page', params.page.toString());
    if (params?.limit) queryParams.append('limit', params.limit.toString());
    if (params?.sortBy) queryParams.append('sortBy', params.sortBy);

    const url = `${process.env.NEXT_PUBLIC_API_URL}/votes/leaderboard${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data: APIResponse<{
      leaderboard: LeaderboardEntry[];
      pagination: any;
    }> = await response.json();

    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to fetch leaderboard');
    }

    return data.data!;
  }
}

export const votesAPI = new VotesAPI();
