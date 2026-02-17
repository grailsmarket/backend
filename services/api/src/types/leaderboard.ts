// TypeScript types for leaderboard API

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

export interface LeaderboardResponse {
  success: boolean;
  data: {
    users: LeaderboardUser[];
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  meta: {
    timestamp: string;
    version: string;
    filters?: {
      clubs?: string[];
    };
    sort: {
      by: SortByOptions;
      order: 'asc' | 'desc';
    };
  };
}

export enum SortByOptions {
  NamesOwned = 'names_owned',
  NamesInClubs = 'names_in_clubs',
  ExpiredNames = 'expired_names',
  NamesListed = 'names_listed',
  NamesSold = 'names_sold',
  SalesVolume = 'sales_volume',
}

export type ValidSortField =
  | 'names_owned'
  | 'names_in_clubs'
  | 'expired_names'
  | 'names_listed'
  | 'names_sold'
  | 'sales_volume';

export interface LeaderboardQueryParams {
  page?: string;
  limit?: string;
  sortBy?: ValidSortField;
  sortOrder?: 'asc' | 'desc';
  'clubs[]'?: string | string[];
}
