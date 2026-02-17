// Leaderboard types for ENS marketplace user rankings

export type SortByField = 'names_owned' | 'names_in_clubs' | 'expired_names' | 'names_listed' | 'names_sold' | 'sales_volume';

export interface LeaderboardUser {
  address: string;
  names_owned: number;
  names_in_clubs: number;
  expired_names: number;
  names_listed: number;
  names_sold: number;
  sales_volume: number; // Total sales volume in ETH
  clubs: string[];
}

export interface LeaderboardQuery {
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
  'clubs[]'?: string | string[];
}

export interface LeaderboardPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface LeaderboardMeta {
  timestamp: string;
  version: string;
  filters?: {
    clubs: string[];
  };
  sort: {
    by: string;
    order: string;
  };
}

export interface LeaderboardResponse {
  success: boolean;
  data: {
    users: LeaderboardUser[];
  };
  pagination: LeaderboardPagination;
  meta: LeaderboardMeta;
}

export interface LeaderboardError {
  success: false;
  error: string;
}
