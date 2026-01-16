/**
 * Integration tests for watchlist search API filters
 *
 * These tests validate the watchlist search endpoint filters including:
 * - Status filters (registered, grace, premium, available)
 * - Tri-state character filters (digits, letters, emoji, repeatingChars)
 * - String pattern filters (contains, startsWith, endsWith, doesNot*)
 * - Listing/market filters (listed, hasOffer)
 * - Sorting (sortBy + sortOrder)
 * - Combined filters
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - Elasticsearch and PostgreSQL populated with data
 * - JWT_SECRET environment variable configured
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';
import jwt from 'jsonwebtoken';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const API_BASE = 'http://localhost:3000/api/v1/watchlist';

// Test user configuration
const TEST_USER_ADDRESS = '0xWATCHLISTTESTUSER00000000000000000001';
let testUserId: number = 0;
let testAuthToken: string = '';

interface WatchlistSearchResult {
  name: string;
  owner?: string;
  expiry_date?: string;
  last_sale_date?: string;
  clubs?: string[];
  listings?: Array<{ status: string; price?: string; source?: string }>;
  has_numbers?: boolean;
  has_emoji?: boolean;
  highest_offer_wei?: string | null;
  watchlist?: {
    watchlistId: number;
    notifyOnSale: boolean;
    notifyOnOffer: boolean;
    notifyOnListing: boolean;
    notifyOnPriceChange: boolean;
    addedAt: string;
  } | null;
}

interface WatchlistSearchResponse {
  success: boolean;
  data?: {
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
  error?: { code: string; message: string };
}

// Helper to get database pool
async function getPool() {
  const { Pool } = await import('pg');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
}

// Helper to generate JWT token
function generateTestToken(userId: number, address: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(
    { sub: userId.toString(), address: address.toLowerCase() },
    secret,
    { expiresIn: '24h' }
  );
}

// Helper to make authenticated search requests
async function searchWatchlist(params: string): Promise<WatchlistSearchResponse> {
  const url = `${API_BASE}/search?${params}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${testAuthToken}`,
    },
  });
  return response.json() as Promise<WatchlistSearchResponse>;
}

// Helper to get label (name without .eth)
function getLabel(name: string): string {
  return name.replace(/\.eth$/, '');
}

describe('Watchlist Search API Filters', () => {
  // Set up test user and watchlist before tests
  beforeAll(async () => {
    // First, verify server is running
    try {
      const response = await fetch('http://localhost:3000/health');
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error) {
      throw new Error(
        'API server not running. Start with: cd services/api && RATE_LIMIT_MAX=1000 npm run dev'
      );
    }

    // Create test user and populate watchlist
    const pool = await getPool();
    try {
      // Create or get test user
      const userResult = await pool.query(`
        INSERT INTO users (address, created_at, updated_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT (address) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `, [TEST_USER_ADDRESS.toLowerCase()]);
      testUserId = userResult.rows[0].id;

      // Generate auth token
      testAuthToken = generateTestToken(testUserId, TEST_USER_ADDRESS);

      // Clear existing watchlist for this test user
      await pool.query('DELETE FROM watchlist WHERE user_id = $1', [testUserId]);

      // Add diverse ENS names to watchlist for testing filters
      // We need a variety of names to test different filters
      const watchlistQuery = `
        INSERT INTO watchlist (user_id, ens_name_id, added_at)
        SELECT $1, en.id, NOW()
        FROM ens_names en
        WHERE en.name IS NOT NULL
          AND en.name NOT LIKE 'token-%'
          AND en.name NOT LIKE '[%'
          AND en.name LIKE '%.eth'
          AND NOT EXISTS (SELECT 1 FROM watchlist w WHERE w.user_id = $1 AND w.ens_name_id = en.id)
        ORDER BY RANDOM()
        LIMIT 100
        ON CONFLICT DO NOTHING
      `;
      await pool.query(watchlistQuery, [testUserId]);

      // Verify watchlist has items
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM watchlist WHERE user_id = $1',
        [testUserId]
      );
      const watchlistCount = parseInt(countResult.rows[0].count);

      if (watchlistCount === 0) {
        throw new Error('Failed to populate test watchlist - no ENS names available');
      }

      console.log(`Test watchlist populated with ${watchlistCount} items`);
    } finally {
      await pool.end();
    }
  });

  // Clean up test user's watchlist after tests
  afterAll(async () => {
    const pool = await getPool();
    try {
      // Remove watchlist entries for test user
      await pool.query('DELETE FROM watchlist WHERE user_id = $1', [testUserId]);
      // Optionally remove test user
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    } catch (error) {
      console.warn('Test cleanup failed (non-critical):', error);
    } finally {
      await pool.end();
    }
  });

  describe('Authentication', () => {
    it('returns 401 without auth token', async () => {
      const response = await fetch(`${API_BASE}/search?limit=1`);
      const data = await response.json() as { success: boolean };
      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
    });

    it('returns results with valid auth token', async () => {
      const { success, data } = await searchWatchlist('limit=5');
      expect(success).toBe(true);
      expect(data?.results).toBeDefined();
      expect(data?.pagination).toBeDefined();
    });
  });

  describe('Basic Functionality', () => {
    it('returns only watchlist items (not all names)', async () => {
      const { success, data } = await searchWatchlist('limit=20');
      expect(success).toBe(true);
      expect(data?.results.length).toBeGreaterThan(0);

      // All results should have watchlist metadata
      for (const result of data!.results) {
        expect(result.watchlist).not.toBeNull();
      }
    });

    it('supports pagination', async () => {
      const page1 = await searchWatchlist('page=1&limit=5');
      const page2 = await searchWatchlist('page=2&limit=5');

      expect(page1.success).toBe(true);
      expect(page2.success).toBe(true);

      if (page1.data!.pagination.totalPages > 1) {
        // Names should be different between pages
        const page1Names = page1.data!.results.map(r => r.name);
        const page2Names = page2.data!.results.map(r => r.name);
        const overlap = page1Names.filter(n => page2Names.includes(n));
        expect(overlap.length).toBe(0);
      }
    });
  });

  describe('Length Filters', () => {
    it('minLength filters to names >= minimum length', async () => {
      const { data } = await searchWatchlist('filters[minLength]=5&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items with minLength >= 5');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeGreaterThanOrEqual(5);
      }
    });

    it('maxLength filters to names <= maximum length', async () => {
      const { data } = await searchWatchlist('filters[maxLength]=4&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items with maxLength <= 4');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeLessThanOrEqual(4);
      }
    });

    it('minLength + maxLength filters to length range', async () => {
      const { data } = await searchWatchlist('filters[minLength]=3&filters[maxLength]=5&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items with length between 3-5');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeGreaterThanOrEqual(3);
        expect(label.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('Tri-state Character Filters', () => {
    it('digits=only returns digit-only names', async () => {
      const { data } = await searchWatchlist('filters[digits]=only&limit=20');
      if (data?.results.length === 0) {
        console.warn('No digit-only watchlist items');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label).toMatch(/^[0-9]+$/);
      }
    });

    it('digits=exclude returns names without digits', async () => {
      const { data } = await searchWatchlist('filters[digits]=exclude&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items without digits');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label).not.toMatch(/[0-9]/);
      }
    });

    it('letters=only returns letter-only names', async () => {
      const { data } = await searchWatchlist('filters[letters]=only&limit=20');
      if (data?.results.length === 0) {
        console.warn('No letter-only watchlist items');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label).toMatch(/^[a-zA-Z]+$/);
      }
    });

    it('letters=exclude returns names without letters', async () => {
      const { data } = await searchWatchlist('filters[letters]=exclude&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items without letters');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label).not.toMatch(/[a-zA-Z]/);
      }
    });
  });

  describe('String Pattern Filters', () => {
    it('startsWith filters to names starting with prefix', async () => {
      const { data } = await searchWatchlist('filters[startsWith]=a&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items starting with "a"');
        return;
      }

      for (const result of data!.results) {
        expect(result.name.toLowerCase()).toMatch(/^a/);
      }
    });

    it('endsWith filters to names ending with suffix (before .eth)', async () => {
      const { data } = await searchWatchlist('filters[endsWith]=e&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items ending with "e"');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.toLowerCase()).toMatch(/e$/);
      }
    });

    it('contains filters to names containing substring', async () => {
      const { data } = await searchWatchlist('filters[contains]=o&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items containing "o"');
        return;
      }

      for (const result of data!.results) {
        expect(result.name.toLowerCase()).toContain('o');
      }
    });

    it('doesNotContain excludes names with substring', async () => {
      const { data } = await searchWatchlist('filters[doesNotContain]=a&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items without "a"');
        return;
      }

      for (const result of data!.results) {
        expect(result.name.toLowerCase()).not.toContain('a');
      }
    });
  });

  describe('Status Filters', () => {
    it('status=registered returns non-expired names', async () => {
      const { data } = await searchWatchlist('filters[status]=registered&limit=20');
      if (data?.results.length === 0) {
        console.warn('No registered watchlist items');
        return;
      }

      const now = new Date();
      for (const result of data!.results) {
        if (result.expiry_date) {
          const expiry = new Date(result.expiry_date);
          expect(expiry.getTime()).toBeGreaterThan(now.getTime());
        }
      }
    });

    it('status=grace returns names in grace period (expired < 90 days)', async () => {
      const { data } = await searchWatchlist('filters[status]=grace&limit=20');
      if (data?.results.length === 0) {
        console.warn('No grace period watchlist items');
        return;
      }

      const now = new Date();
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!);
        expect(expiry.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(expiry.getTime()).toBeGreaterThan(ninetyDaysAgo.getTime());
      }
    });
  });

  describe('Listing Filters', () => {
    it('listed=true returns only listed watchlist items', async () => {
      const { data } = await searchWatchlist('filters[listed]=true&limit=20');
      if (data?.results.length === 0) {
        console.warn('No listed watchlist items');
        return;
      }

      for (const result of data!.results) {
        const hasActiveListing = result.listings?.some(l => l.status === 'active');
        expect(hasActiveListing).toBe(true);
      }
    });

    it('listed=false returns only unlisted watchlist items', async () => {
      const { data } = await searchWatchlist('filters[listed]=false&limit=20');
      if (data?.results.length === 0) {
        console.warn('No unlisted watchlist items');
        return;
      }

      for (const result of data!.results) {
        const hasActiveListing = result.listings?.some(l => l.status === 'active');
        expect(hasActiveListing).toBeFalsy();
      }
    });
  });

  describe('Sorting', () => {
    it('sortBy=alphabetical&sortOrder=asc sorts A-Z', async () => {
      const { data } = await searchWatchlist('sortBy=alphabetical&sortOrder=asc&limit=20');
      expect(data?.results.length).toBeGreaterThan(1);

      const names = data!.results.map(r => r.name.toLowerCase());
      const sortedNames = [...names].sort();
      expect(names).toEqual(sortedNames);
    });

    it('sortBy=alphabetical&sortOrder=desc sorts Z-A', async () => {
      const { data } = await searchWatchlist('sortBy=alphabetical&sortOrder=desc&limit=20');
      expect(data?.results.length).toBeGreaterThan(1);

      const names = data!.results.map(r => r.name.toLowerCase());
      const sortedNames = [...names].sort().reverse();
      expect(names).toEqual(sortedNames);
    });

    it('sortBy=expiry_date&sortOrder=asc sorts by nearest expiry first', async () => {
      const { data } = await searchWatchlist('sortBy=expiry_date&sortOrder=asc&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items with expiry dates');
        return;
      }

      const dates = data!.results
        .filter(r => r.expiry_date)
        .map(r => new Date(r.expiry_date!).getTime());

      if (dates.length < 2) return;

      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
      }
    });
  });

  describe('Combined Filters', () => {
    it('combines length + letter filters', async () => {
      const { data } = await searchWatchlist('filters[minLength]=3&filters[maxLength]=5&filters[letters]=only&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items matching combined filters');
        return;
      }

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeGreaterThanOrEqual(3);
        expect(label.length).toBeLessThanOrEqual(5);
        expect(label).toMatch(/^[a-zA-Z]+$/);
      }
    });

    it('combines status + sorting', async () => {
      const { data } = await searchWatchlist('filters[status]=registered&sortBy=alphabetical&sortOrder=asc&limit=20');
      if (data?.results.length === 0) {
        console.warn('No registered watchlist items');
        return;
      }

      // Verify status filter
      const now = new Date();
      for (const result of data!.results) {
        if (result.expiry_date) {
          const expiry = new Date(result.expiry_date);
          expect(expiry.getTime()).toBeGreaterThan(now.getTime());
        }
      }

      // Verify sorting
      const names = data!.results.map(r => r.name.toLowerCase());
      const sortedNames = [...names].sort();
      expect(names).toEqual(sortedNames);
    });
  });

  describe('Club Filters', () => {
    it('clubs[]=999 filters to 999 club items', async () => {
      const { data } = await searchWatchlist('filters[clubs][]=999&limit=20');
      if (data?.results.length === 0) {
        console.warn('No 999 club watchlist items');
        return;
      }

      for (const result of data!.results) {
        expect(result.clubs).toContain('999');
      }
    });

    it('inAnyClub=true returns items in any club', async () => {
      const { data } = await searchWatchlist('filters[inAnyClub]=true&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items in any club');
        return;
      }

      for (const result of data!.results) {
        expect(result.clubs?.length).toBeGreaterThan(0);
      }
    });

    it('inAnyClub=false returns items not in any club', async () => {
      const { data } = await searchWatchlist('filters[inAnyClub]=false&limit=20');
      if (data?.results.length === 0) {
        console.warn('No watchlist items outside of clubs');
        return;
      }

      for (const result of data!.results) {
        // clubs should be empty array, null, or undefined
        expect(result.clubs === null || result.clubs === undefined || result.clubs.length === 0).toBe(true);
      }
    });
  });
});
