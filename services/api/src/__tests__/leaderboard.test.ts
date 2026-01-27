/**
 * Integration tests for leaderboard API endpoint
 *
 * Tests the user leaderboard functionality which:
 * - Ranks users by ENS name holdings
 * - Supports sorting by names_owned, names_in_clubs, expired_names
 * - Supports filtering by clubs
 * - Returns aggregated club data per user
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - PostgreSQL populated with ens_names data
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'http://localhost:3000/api/v1/leaderboard';

interface LeaderboardUser {
  address: string;
  names_owned: number;
  names_in_clubs: number;
  expired_names: number;
  clubs: string[];
}

interface LeaderboardResponse {
  success: boolean;
  data?: {
    users: LeaderboardUser[];
  };
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  meta?: {
    timestamp: string;
    version: string;
    filters?: {
      clubs: string[];
    };
    sort: {
      by: string;
      order: string;
    };
  };
  error?: string;
}

// Helper to make leaderboard requests
async function getLeaderboard(params: string = ''): Promise<{ status: number; data: LeaderboardResponse }> {
  const url = params ? `${API_BASE}?${params}` : API_BASE;
  const response = await fetch(url);
  const data = await response.json() as LeaderboardResponse;
  return { status: response.status, data };
}

describe('Leaderboard API', () => {
  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch(API_BASE);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const data = await response.json() as LeaderboardResponse;
      if (!data.success) {
        throw new Error('API returned error');
      }
    } catch (error: any) {
      if (error.message?.includes('fetch failed') || error.cause?.code === 'ECONNREFUSED') {
        throw new Error(
          'API server not running. Start with: cd services/api && npm run dev'
        );
      }
      throw error;
    }
  });

  describe('Basic Functionality', () => {
    it('returns success response with users array', async () => {
      const { status, data } = await getLeaderboard();

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data!.users).toBeInstanceOf(Array);
    });

    it('returns correct user structure', async () => {
      const { data } = await getLeaderboard('limit=1');

      expect(data.data!.users.length).toBeGreaterThan(0);
      const user = data.data!.users[0];

      expect(user).toHaveProperty('address');
      expect(user).toHaveProperty('names_owned');
      expect(user).toHaveProperty('names_in_clubs');
      expect(user).toHaveProperty('expired_names');
      expect(user).toHaveProperty('clubs');

      expect(typeof user.address).toBe('string');
      expect(typeof user.names_owned).toBe('number');
      expect(typeof user.names_in_clubs).toBe('number');
      expect(typeof user.expired_names).toBe('number');
      expect(user.clubs).toBeInstanceOf(Array);
    });

    it('returns pagination metadata', async () => {
      const { data } = await getLeaderboard();

      expect(data.pagination).toBeDefined();
      expect(data.pagination!.page).toBe(1);
      expect(data.pagination!.limit).toBe(20);
      expect(typeof data.pagination!.total).toBe('number');
      expect(typeof data.pagination!.pages).toBe('number');
    });

    it('returns meta with sort info', async () => {
      const { data } = await getLeaderboard();

      expect(data.meta).toBeDefined();
      expect(data.meta!.sort).toBeDefined();
      expect(data.meta!.sort.by).toBe('names_owned');
      expect(data.meta!.sort.order).toBe('desc');
    });
  });

  describe('Pagination', () => {
    it('respects page parameter', async () => {
      const { data: page1 } = await getLeaderboard('page=1&limit=5');
      const { data: page2 } = await getLeaderboard('page=2&limit=5');

      expect(page1.pagination!.page).toBe(1);
      expect(page2.pagination!.page).toBe(2);

      // If there's more than one page, users should be different
      if (page2.data!.users.length > 0 && page1.pagination!.total > 5) {
        expect(page1.data!.users[0].address).not.toBe(page2.data!.users[0].address);
      }
    });

    it('respects limit parameter', async () => {
      const { data } = await getLeaderboard('limit=5');

      expect(data.pagination!.limit).toBe(5);
      expect(data.data!.users.length).toBeLessThanOrEqual(5);
    });

    it('enforces maximum limit of 100', async () => {
      const { data } = await getLeaderboard('limit=200');

      expect(data.pagination!.limit).toBe(100);
    });

    it('enforces minimum limit of 1', async () => {
      const { data } = await getLeaderboard('limit=0');

      expect(data.pagination!.limit).toBe(1);
    });
  });

  describe('Sorting', () => {
    it('sorts by names_owned descending by default', async () => {
      const { data } = await getLeaderboard('limit=10');

      const users = data.data!.users;
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].names_owned).toBeGreaterThanOrEqual(users[i].names_owned);
      }
    });

    it('sorts by names_owned ascending', async () => {
      const { data } = await getLeaderboard('sortBy=names_owned&sortOrder=asc&limit=10');

      expect(data.meta!.sort.by).toBe('names_owned');
      expect(data.meta!.sort.order).toBe('asc');

      const users = data.data!.users;
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].names_owned).toBeLessThanOrEqual(users[i].names_owned);
      }
    });

    it('sorts by names_in_clubs descending', async () => {
      const { data } = await getLeaderboard('sortBy=names_in_clubs&sortOrder=desc&limit=10');

      expect(data.meta!.sort.by).toBe('names_in_clubs');
      expect(data.meta!.sort.order).toBe('desc');

      const users = data.data!.users;
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].names_in_clubs).toBeGreaterThanOrEqual(users[i].names_in_clubs);
      }
    });

    it('sorts by names_in_clubs ascending', async () => {
      const { data } = await getLeaderboard('sortBy=names_in_clubs&sortOrder=asc&limit=10');

      const users = data.data!.users;
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].names_in_clubs).toBeLessThanOrEqual(users[i].names_in_clubs);
      }
    });

    it('sorts by expired_names descending', async () => {
      const { data } = await getLeaderboard('sortBy=expired_names&sortOrder=desc&limit=10');

      expect(data.meta!.sort.by).toBe('expired_names');
      expect(data.meta!.sort.order).toBe('desc');

      const users = data.data!.users;
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].expired_names).toBeGreaterThanOrEqual(users[i].expired_names);
      }
    });

    it('sorts by expired_names ascending', async () => {
      const { data } = await getLeaderboard('sortBy=expired_names&sortOrder=asc&limit=10');

      const users = data.data!.users;
      for (let i = 1; i < users.length; i++) {
        expect(users[i - 1].expired_names).toBeLessThanOrEqual(users[i].expired_names);
      }
    });

    it('falls back to default sort for invalid sortBy', async () => {
      const { data } = await getLeaderboard('sortBy=invalid_field&limit=10');

      expect(data.meta!.sort.by).toBe('names_owned');
    });
  });

  describe('Club Filtering', () => {
    it('filters by single club', async () => {
      const { data } = await getLeaderboard('clubs[]=999&limit=10');

      expect(data.meta!.filters).toBeDefined();
      expect(data.meta!.filters!.clubs).toContain('999');

      // All returned users should have at least one active name in the 999 club
      // (verified by the filter working - they should have the club in their list)
      for (const user of data.data!.users) {
        // Users filtered by club should have names in clubs
        expect(user.names_in_clubs).toBeGreaterThan(0);
      }
    });

    it('filters by multiple clubs', async () => {
      const { data } = await getLeaderboard('clubs[]=999&clubs[]=10k&limit=10');

      expect(data.meta!.filters!.clubs).toContain('999');
      expect(data.meta!.filters!.clubs).toContain('10k');
    });

    it('returns fewer results when filtering by club', async () => {
      const { data: unfiltered } = await getLeaderboard();
      const { data: filtered } = await getLeaderboard('clubs[]=999');

      // Filtered results should be equal or fewer
      expect(filtered.pagination!.total).toBeLessThanOrEqual(unfiltered.pagination!.total);
    });

    it('does not include filters in meta when no club filter', async () => {
      const { data } = await getLeaderboard();

      expect(data.meta!.filters).toBeUndefined();
    });
  });

  describe('Data Validation', () => {
    it('names_in_clubs is always <= names_owned', async () => {
      const { data } = await getLeaderboard('limit=50');

      for (const user of data.data!.users) {
        expect(user.names_in_clubs).toBeLessThanOrEqual(user.names_owned);
      }
    });

    it('names_owned is always > 0 for returned users', async () => {
      const { data } = await getLeaderboard('limit=50');

      for (const user of data.data!.users) {
        expect(user.names_owned).toBeGreaterThan(0);
      }
    });

    it('address is a valid ethereum address format', async () => {
      const { data } = await getLeaderboard('limit=10');

      for (const user of data.data!.users) {
        expect(user.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    it('clubs array contains only strings', async () => {
      const { data } = await getLeaderboard('limit=10');

      for (const user of data.data!.users) {
        for (const club of user.clubs) {
          expect(typeof club).toBe('string');
        }
      }
    });

    it('clubs array is sorted alphabetically', async () => {
      const { data } = await getLeaderboard('limit=10');

      for (const user of data.data!.users) {
        if (user.clubs.length > 1) {
          const sorted = [...user.clubs].sort();
          expect(user.clubs).toEqual(sorted);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles empty result for non-existent club filter', async () => {
      const { status, data } = await getLeaderboard('clubs[]=nonexistent_club_xyz123');

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data!.users).toEqual([]);
      expect(data.pagination!.total).toBe(0);
    });

    it('handles page beyond available data', async () => {
      const { status, data } = await getLeaderboard('page=99999&limit=100');

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data!.users).toEqual([]);
    });
  });
});
