/**
 * Integration tests for search API filters
 *
 * These tests hit the running API server and validate that results
 * match the expected filter criteria.
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - Elasticsearch and PostgreSQL populated with data
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'http://localhost:3000/api/v1/search';

interface SearchResult {
  name: string;
  owner?: string;
  expiry_date?: string;
  last_sale_date?: string;
  clubs?: string[];
  listings?: Array<{ status: string; price?: string; source?: string }>;
  has_numbers?: boolean;
  has_emoji?: boolean;
  highest_offer_wei?: string | null;
  view_count: number;
  watchers_count: number;
}

interface SearchResponse {
  success: boolean;
  data?: {
    results: SearchResult[];
    pagination: { total: number };
  };
}

// Helper to make search requests
async function search(params: string): Promise<SearchResponse> {
  const url = `${API_BASE}?${params}`;
  const response = await fetch(url);
  return response.json() as Promise<SearchResponse>;
}

// Helper to get label (name without .eth)
function getLabel(name: string): string {
  return name.replace(/\.eth$/, '');
}

// Comprehensive emoji regex - matches the shared EMOJI_REGEX from shared module
const EMOJI_REGEX =
  /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;

// Helper to safely convert offer values to BigInt
// JSON parsing can turn large numbers into floats, so we handle both string and number inputs
function toBigInt(value: string | number): bigint {
  if (typeof value === 'string') {
    // Remove any decimal part if present (shouldn't be, but just in case)
    return BigInt(value.split('.')[0]);
  }
  // For numbers, convert to string first to avoid float precision issues
  return BigInt(Math.floor(value).toString());
}

describe('Search API Filters', () => {
  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch(`${API_BASE}?limit=1`);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error) {
      throw new Error(
        'API server not running. Start with: cd services/api && npm run dev'
      );
    }
  });

  describe('Listing Status Filters', () => {
    it('showListings=true returns only names with active listings', async () => {
      const { data } = await search('filters[showListings]=true&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const result of data!.results) {
        const hasActiveListing = result.listings?.some(
          (l) => l.status === 'active'
        );
        if (!hasActiveListing) {
          failures.push(`${result.name} (listings: ${result.listings?.length ?? 0})`);
        }
      }

      expect(failures, `Names without active listings: ${failures.join(', ')}`).toHaveLength(0);
    });

    it('showUnlisted=true returns only names without active listings', async () => {
      const { data } = await search('filters[showUnlisted]=true&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const hasActiveListing = result.listings?.some(
          (l) => l.status === 'active'
        );
        expect(hasActiveListing).toBeFalsy();
      }
    });
  });

  describe('Price Filters', () => {
    it('minPrice filters to listings >= minimum price', async () => {
      const minPrice = '1000000000000000000'; // 1 ETH
      const { data } = await search(
        `filters[showListings]=true&filters[minPrice]=${minPrice}&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const result of data!.results) {
        const listing = result.listings?.find((l) => l.status === 'active');
        if (!listing) {
          failures.push(`${result.name}: no active listing (ES/DB drift)`);
          continue;
        }
        const price = BigInt(listing.price!);
        if (price < BigInt(minPrice)) {
          failures.push(`${result.name}: price ${price} < ${minPrice}`);
        }
      }

      expect(failures, `Price filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('maxPrice filters to listings <= maximum price', async () => {
      const maxPrice = '10000000000000000000'; // 10 ETH
      const { data } = await search(
        `filters[showListings]=true&filters[maxPrice]=${maxPrice}&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const result of data!.results) {
        const listing = result.listings?.find((l) => l.status === 'active');
        if (!listing) {
          failures.push(`${result.name}: no active listing (ES/DB drift)`);
          continue;
        }
        const price = BigInt(listing.price!);
        if (price > BigInt(maxPrice)) {
          failures.push(`${result.name}: price ${price} > ${maxPrice}`);
        }
      }

      expect(failures, `Price filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('minPrice + maxPrice filters to price range', async () => {
      const minPrice = '1000000000000000000'; // 1 ETH
      const maxPrice = '5000000000000000000'; // 5 ETH
      const { data } = await search(
        `filters[showListings]=true&filters[minPrice]=${minPrice}&filters[maxPrice]=${maxPrice}&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const result of data!.results) {
        const listing = result.listings?.find((l) => l.status === 'active');
        if (!listing) {
          failures.push(`${result.name}: no active listing (ES/DB drift)`);
          continue;
        }
        const price = BigInt(listing.price!);
        if (price < BigInt(minPrice) || price > BigInt(maxPrice)) {
          failures.push(`${result.name}: price ${price} not in range [${minPrice}, ${maxPrice}]`);
        }
      }

      expect(failures, `Price filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });
  });

  describe('Character Filters', () => {
    it('hasNumbers=true returns names containing digits', async () => {
      const { data } = await search('filters[hasNumbers]=true&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(/\d/.test(label)).toBe(true);
      }
    });

    it('hasNumbers=false returns names without digits', async () => {
      const { data } = await search('filters[hasNumbers]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(/\d/.test(label)).toBe(false);
      }
    });

    it('hasEmoji=true returns names containing emoji', async () => {
      const { data } = await search('filters[hasEmoji]=true&limit=50');
      // May have no emoji names in dataset
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        expect(EMOJI_REGEX.test(result.name)).toBe(true);
      }
    });

    it('hasEmoji=false returns names without emoji', async () => {
      const { data } = await search('filters[hasEmoji]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(EMOJI_REGEX.test(result.name)).toBe(false);
      }
    });

    it('minLength filters to names with minimum character count', async () => {
      const minLength = 5;
      const { data } = await search(`filters[minLength]=${minLength}&limit=50`);
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeGreaterThanOrEqual(minLength);
      }
    });

    it('maxLength filters to names with maximum character count', async () => {
      const maxLength = 4;
      const { data } = await search(`filters[maxLength]=${maxLength}&limit=50`);
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeLessThanOrEqual(maxLength);
      }
    });

    it('minLength + maxLength filters to exact length range', async () => {
      const minLength = 3;
      const maxLength = 4;
      const { data } = await search(
        `filters[minLength]=${minLength}&filters[maxLength]=${maxLength}&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name);
        expect(label.length).toBeGreaterThanOrEqual(minLength);
        expect(label.length).toBeLessThanOrEqual(maxLength);
      }
    });
  });

  describe('Count Filters', () => {
    describe('Watchers Count Filters', () => {
      it('minWatchersCount filters to names with at least N watchers', async () => {
        const minWatchers = 1;
        const { data } = await search(`filters[minWatchersCount]=${minWatchers}&limit=20`);
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          expect(result.watchers_count).toBeGreaterThanOrEqual(minWatchers);
        }
      });

      it('maxWatchersCount filters to names with at most N watchers', async () => {
        // Combine with minWatchersCount to narrow result set and speed up query
        const minWatchers = 1;
        const maxWatchers = 5;
        const { data } = await search(
          `filters[minWatchersCount]=${minWatchers}&filters[maxWatchersCount]=${maxWatchers}&limit=50`
        );
        // May have no names in this range
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.watchers_count).toBeLessThanOrEqual(maxWatchers);
        }
      }, 60000);

      it('minWatchersCount + maxWatchersCount filters to range', async () => {
        const minWatchers = 2;
        const maxWatchers = 10;
        const { data } = await search(
          `filters[minWatchersCount]=${minWatchers}&filters[maxWatchersCount]=${maxWatchers}&limit=50`
        );
        // May have no names in this range
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.watchers_count).toBeGreaterThanOrEqual(minWatchers);
          expect(result.watchers_count).toBeLessThanOrEqual(maxWatchers);
        }
      });
    });

    describe('View Count Filters', () => {
      it('minViewCount filters to names with at least N views', async () => {
        const minViews = 10;
        const { data } = await search(`filters[minViewCount]=${minViews}&limit=50`);
        // May have no names with this many views
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.view_count).toBeGreaterThanOrEqual(minViews);
        }
      });

      it('maxViewCount filters to names with at most N views', async () => {
        // Combine with minViewCount to narrow result set and speed up query
        const minViews = 1;
        const maxViews = 100;
        const { data } = await search(
          `filters[minViewCount]=${minViews}&filters[maxViewCount]=${maxViews}&limit=50`
        );
        // May have no names in this range
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.view_count).toBeLessThanOrEqual(maxViews);
        }
      }, 60000);

      it('minViewCount + maxViewCount filters to range', async () => {
        const minViews = 5;
        const maxViews = 50;
        const { data } = await search(
          `filters[minViewCount]=${minViews}&filters[maxViewCount]=${maxViews}&limit=50`
        );
        // May have no names in this range
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.view_count).toBeGreaterThanOrEqual(minViews);
          expect(result.view_count).toBeLessThanOrEqual(maxViews);
        }
      });
    });

    describe('Clubs Count Filters', () => {
      it('minClubsCount filters to names in at least N clubs', async () => {
        const minClubs = 1;
        const { data } = await search(`filters[minClubsCount]=${minClubs}&limit=50`);
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          expect(result.clubs?.length ?? 0).toBeGreaterThanOrEqual(minClubs);
        }
      });

      it('maxClubsCount=0 filters to names not in any club', async () => {
        // Add startsWith filter to narrow result set and speed up query
        // (maxClubsCount=0 alone returns 3M+ names)
        const { data } = await search('filters[maxClubsCount]=0&filters[startsWith]=test&limit=50');
        // May have no names matching both criteria
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.clubs?.length ?? 0).toBe(0);
        }
      }, 60000);

      it('minClubsCount + maxClubsCount filters to exact count', async () => {
        const exactCount = 1;
        const { data } = await search(
          `filters[minClubsCount]=${exactCount}&filters[maxClubsCount]=${exactCount}&limit=50`
        );
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          expect(result.clubs?.length ?? 0).toBe(exactCount);
        }
      });

      it('minClubsCount=2 filters to names in multiple clubs', async () => {
        const { data } = await search('filters[minClubsCount]=2&limit=50');
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          expect(result.clubs?.length ?? 0).toBeGreaterThanOrEqual(2);
        }
      });
    });

    describe('Combined Count Filters', () => {
      it('count filters combined with other filters', async () => {
        // Names with at least 1 watcher, in at least 1 club
        const { data } = await search(
          'filters[minWatchersCount]=1&filters[minClubsCount]=1&limit=50'
        );
        // May have no names matching both criteria
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          expect(result.watchers_count).toBeGreaterThanOrEqual(1);
          expect(result.clubs?.length ?? 0).toBeGreaterThanOrEqual(1);
        }
      });

      it('count filters combined with length filters', async () => {
        // Short names (3-4 chars) with at least 1 watcher
        const { data } = await search(
          'filters[minLength]=3&filters[maxLength]=4&filters[minWatchersCount]=1&limit=50'
        );
        // May have no names matching all criteria
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          const label = getLabel(result.name);
          expect(label.length).toBeGreaterThanOrEqual(3);
          expect(label.length).toBeLessThanOrEqual(4);
          expect(result.watchers_count).toBeGreaterThanOrEqual(1);
        }
      });

      it('count filters combined with listing filter', async () => {
        // Listed names with at least 1 view
        const { data } = await search(
          'filters[listed]=true&filters[minViewCount]=1&limit=50'
        );
        // May have no names matching both criteria
        if (data?.results.length === 0) return;

        const failures: string[] = [];
        for (const result of data!.results) {
          const hasActiveListing = result.listings?.some((l) => l.status === 'active');
          if (!hasActiveListing) {
            failures.push(`${result.name}: no active listing`);
          }
          if (result.view_count < 1) {
            failures.push(`${result.name}: view_count ${result.view_count} < 1`);
          }
        }

        expect(failures, `Combined filter failures:\n${failures.join('\n')}`).toHaveLength(0);
      });
    });
  });

  describe('Club Filters', () => {
    it('clubs[]=999 returns names in 999 club', async () => {
      const { data } = await search('filters[clubs][]=999&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.clubs).toContain('999');
      }
    });

    it('clubs[]=10k returns names in 10k club', async () => {
      const { data } = await search('filters[clubs][]=10k&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.clubs).toContain('10k');
      }
    });

    it('multiple clubs filters with OR logic', async () => {
      const { data } = await search(
        'filters[clubs][]=999&filters[clubs][]=10k&limit=50'
      );
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const inRequestedClub =
          result.clubs?.includes('999') || result.clubs?.includes('10k');
        expect(inRequestedClub).toBe(true);
      }
    });

    it('inAnyClub=true returns names in at least one club', async () => {
      const { data } = await search('filters[inAnyClub]=true&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.clubs?.length).toBeGreaterThan(0);
      }
    });

    it('inAnyClub=false returns names not in any club', async () => {
      const { data } = await search('filters[inAnyClub]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.clubs?.length ?? 0).toBe(0);
      }
    });

    it('clubs[]=none returns names not in any club', async () => {
      const { data } = await search('filters[clubs][]=none&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.clubs?.length ?? 0).toBe(0);
      }
    });

    it('clubs[]=any returns names in at least one club', async () => {
      const { data } = await search('filters[clubs][]=any&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.clubs?.length).toBeGreaterThan(0);
      }
    });

    it('clubs[]=any with excludeClubs returns names in clubs except excluded ones', async () => {
      const excludedClubs = ['bip_39', 'prepunks'];
      const { data } = await search(
        `filters[clubs][]=any&filters[excludeClubs][]=bip_39&filters[excludeClubs][]=prepunks&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        // Should be in at least one club
        expect(result.clubs?.length).toBeGreaterThan(0);
        // Should not be in any excluded club
        for (const excludedClub of excludedClubs) {
          expect(result.clubs).not.toContain(excludedClub);
        }
      }
    });

    it('excludeClubs by itself excludes names in those clubs (allows no-club names)', async () => {
      const excludedClubs = ['999', '10k'];
      const { data } = await search(
        `filters[excludeClubs][]=999&filters[excludeClubs][]=10k&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        // Should not be in any excluded club (but can be in no clubs at all)
        if (result.clubs && result.clubs.length > 0) {
          for (const excludedClub of excludedClubs) {
            expect(result.clubs).not.toContain(excludedClub);
          }
        }
        // Names with no clubs are allowed
      }
    });
  });

  describe('Expiration Filters', () => {
    it('isExpired=true returns expired names', async () => {
      const { data } = await search('filters[isExpired]=true&limit=50');
      // May have no expired names
      if (data?.results.length === 0) return;

      const now = Date.now();
      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        expect(new Date(result.expiry_date!).getTime()).toBeLessThan(now);
      }
    });

    it('isExpired=false returns non-expired names', async () => {
      const { data } = await search('filters[isExpired]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const now = Date.now();
      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        expect(new Date(result.expiry_date!).getTime()).toBeGreaterThan(now);
      }
    });

    it('isGracePeriod=true returns names expired within 90 days', async () => {
      const { data } = await search('filters[isGracePeriod]=true&limit=50');
      // May have no grace period names
      if (data?.results.length === 0) return;

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeLessThan(now);
        expect(expiry).toBeGreaterThan(ninetyDaysAgo);
      }
    });

    it('isPremiumPeriod=true returns names expired 90-111 days ago', async () => {
      const { data } = await search('filters[isPremiumPeriod]=true&limit=50');
      // May have no premium period names
      if (data?.results.length === 0) return;

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
      const oneElevenDaysAgo = now - 111 * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeLessThanOrEqual(ninetyDaysAgo);
        expect(expiry).toBeGreaterThan(oneElevenDaysAgo);
      }
    });

    it('expiringWithinDays filters to names expiring soon', async () => {
      const days = 30;
      const { data } = await search(
        `filters[expiringWithinDays]=${days}&limit=50`
      );
      // May have no names expiring within 30 days
      if (data?.results.length === 0) return;

      const now = Date.now();
      const futureDate = now + days * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeGreaterThan(now);
        expect(expiry).toBeLessThanOrEqual(futureDate);
      }
    });
  });

  describe('Sale History Filters', () => {
    it('hasSales=true returns names with sale history', async () => {
      const { data } = await search('filters[hasSales]=true&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.last_sale_date).not.toBeNull();
      }
    });

    it('hasSales=false returns names without sale history', async () => {
      const { data } = await search('filters[hasSales]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.last_sale_date).toBeNull();
      }
    });

    it('lastSoldAfter filters to names sold after date', async () => {
      const afterDate = '2024-01-01T00:00:00Z';
      const { data } = await search(
        `filters[hasSales]=true&filters[lastSoldAfter]=${afterDate}&limit=50`
      );
      // May have no sales after this date
      if (data?.results.length === 0) return;

      const after = new Date(afterDate).getTime();
      for (const result of data!.results) {
        expect(result.last_sale_date).toBeDefined();
        expect(new Date(result.last_sale_date!).getTime()).toBeGreaterThanOrEqual(after);
      }
    });

    it('lastSoldBefore filters to names sold before date', async () => {
      const beforeDate = '2024-06-01T00:00:00Z';
      const { data } = await search(
        `filters[hasSales]=true&filters[lastSoldBefore]=${beforeDate}&limit=50`
      );
      // May have no sales before this date
      if (data?.results.length === 0) return;

      const before = new Date(beforeDate).getTime();
      for (const result of data!.results) {
        expect(result.last_sale_date).toBeDefined();
        expect(new Date(result.last_sale_date!).getTime()).toBeLessThanOrEqual(before);
      }
    });
  });

  describe('Owner Filter', () => {
    it('owner filter returns names owned by address', async () => {
      // First get a name to find an owner address
      const { data: initial } = await search('limit=1');
      if (!initial?.results.length || !initial.results[0].owner) {
        return; // Skip if no data
      }

      const ownerAddress = initial.results[0].owner;
      const { data } = await search(
        `filters[owner]=${ownerAddress}&limit=50`
      );
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        expect(result.owner?.toLowerCase()).toBe(ownerAddress.toLowerCase());
      }
    });
  });

  describe('Combined Filters', () => {
    it('combines multiple filters correctly', async () => {
      const { data } = await search(
        'filters[hasNumbers]=true&filters[minLength]=3&filters[maxLength]=5&filters[showListings]=true&limit=50'
      );

      // May have no results matching all criteria
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const label = getLabel(result.name);

        // hasNumbers=true
        if (!/\d/.test(label)) {
          failures.push(`${result.name}: no digits`);
        }

        // minLength=3, maxLength=5
        if (label.length < 3 || label.length > 5) {
          failures.push(`${result.name}: length ${label.length} not in [3,5]`);
        }

        // showListings=true
        const hasActiveListing = result.listings?.some(
          (l) => l.status === 'active'
        );
        if (!hasActiveListing) {
          failures.push(`${result.name}: no active listing (ES/DB drift)`);
        }
      }

      expect(failures, `Combined filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('4-digit 10k club names with listings', async () => {
      const { data } = await search(
        'filters[clubs][]=10k&filters[minLength]=4&filters[maxLength]=4&filters[showListings]=true&limit=50'
      );

      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const label = getLabel(result.name);

        if (!result.clubs?.includes('10k')) {
          failures.push(`${result.name}: not in 10k club`);
        }
        if (label.length !== 4) {
          failures.push(`${result.name}: length ${label.length} != 4`);
        }
        if (!result.listings?.some((l) => l.status === 'active')) {
          failures.push(`${result.name}: no active listing (ES/DB drift)`);
        }
      }

      expect(failures, `10k club filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('short repeating digit names (e.g., 999, 1111)', async () => {
      // Realistic search: repeating characters, digits only, less than 5 chars
      const { data } = await search(
        'filters[repeatingChars]=only&filters[digits]=only&filters[maxLength]=4&limit=50'
      );

      // May have no matching names
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const label = getLabel(result.name);

        // repeatingChars=only: all characters must be the same
        const firstChar = label[0];
        const isAllSame = label.split('').every((c) => c === firstChar);
        if (!isAllSame) {
          failures.push(`${result.name}: not all same character`);
        }

        // digits=only: must contain only digits
        if (!/^[0-9]+$/.test(label)) {
          failures.push(`${result.name}: contains non-digits`);
        }

        // maxLength=4: must be 4 chars or less
        if (label.length > 4) {
          failures.push(`${result.name}: length ${label.length} > 4`);
        }
      }

      expect(failures, `Repeating digit filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('short letter-only names that are listed', async () => {
      // Realistic search: letters only, 3-4 chars, with active listings
      const { data } = await search(
        'filters[letters]=only&filters[minLength]=3&filters[maxLength]=4&filters[listed]=true&limit=50'
      );

      // May have no matching names
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const label = getLabel(result.name);

        // letters=only: must contain only letters
        if (!/^[a-zA-Z]+$/.test(label)) {
          failures.push(`${result.name}: contains non-letters`);
        }

        // length 3-4
        if (label.length < 3 || label.length > 4) {
          failures.push(`${result.name}: length ${label.length} not in [3,4]`);
        }

        // listed=true: must have active listing
        const hasActiveListing = result.listings?.some((l) => l.status === 'active');
        if (!hasActiveListing) {
          failures.push(`${result.name}: no active listing (ES/DB drift)`);
        }
      }

      expect(failures, `Short letter names filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('names starting with "a" without emoji', async () => {
      // Realistic search: starts with prefix, no emoji
      const { data } = await search(
        'filters[startsWith]=a&filters[emoji]=exclude&limit=50'
      );

      // May have no matching names
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();

        // startsWith=a: must start with "a"
        if (!label.startsWith('a')) {
          failures.push(`${result.name}: doesn't start with 'a'`);
        }

        // emoji=exclude: must not have emoji
        if (result.has_emoji) {
          failures.push(`${result.name}: has emoji`);
        }
      }

      expect(failures, `StartsWith + emoji filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });
  });

  describe('Tri-State Character Filters', () => {
    describe('Digits Filter', () => {
      it('digits=exclude returns names without any digits', async () => {
        const { data } = await search('filters[digits]=exclude&limit=50');
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          const label = getLabel(result.name);
          expect(/\d/.test(label)).toBe(false);
        }
      });

      it('digits=only returns names containing ONLY digits', async () => {
        const { data } = await search('filters[digits]=only&limit=50');
        // May have no digit-only names
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          const label = getLabel(result.name);
          expect(/^[0-9]+$/.test(label)).toBe(true);
        }
      });
    });

    describe('Letters Filter', () => {
      it('letters=exclude returns names without any letters', async () => {
        const { data } = await search('filters[letters]=exclude&limit=50');
        // May have no names without letters
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          const label = getLabel(result.name);
          expect(/[a-zA-Z]/.test(label)).toBe(false);
        }
      });

      it('letters=only returns names containing ONLY letters', async () => {
        const { data } = await search('filters[letters]=only&limit=50');
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          const label = getLabel(result.name);
          expect(/^[a-zA-Z]+$/.test(label)).toBe(true);
        }
      });
    });

    describe('Emoji Filter', () => {
      it('emoji=exclude returns names without any emoji', async () => {
        const { data } = await search('filters[emoji]=exclude&limit=50');
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          expect(EMOJI_REGEX.test(result.name)).toBe(false);
        }
      });

      it('emoji=only returns names containing ONLY emoji', async () => {
        const { data } = await search('filters[emoji]=only&limit=50');
        // May have no emoji-only names
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          const label = getLabel(result.name);
          // Should have emoji and no alphanumeric characters
          expect(EMOJI_REGEX.test(result.name)).toBe(true);
          expect(/[a-zA-Z0-9]/.test(label)).toBe(false);
        }
      });
    });

    describe('Repeating Characters Filter', () => {
      // Helper to check if all characters in a string are the same
      const isAllSameChar = (str: string): boolean => {
        if (str.length === 0) return false;
        const firstChar = str[0];
        return str.split('').every((c) => c === firstChar);
      };

      it('repeatingChars=exclude returns names where NOT all chars are the same', async () => {
        const { data } = await search('filters[repeatingChars]=exclude&limit=50');
        expect(data?.results.length).toBeGreaterThan(0);

        for (const result of data!.results) {
          const label = getLabel(result.name);
          // Should NOT be all same character (e.g., "99999" would be excluded)
          expect(isAllSameChar(label)).toBe(false);
        }
      });

      it('repeatingChars=only returns names where ALL chars are the same', async () => {
        const { data } = await search('filters[repeatingChars]=only&limit=50');
        // May have no mono-character names
        if (data?.results.length === 0) return;

        for (const result of data!.results) {
          const label = getLabel(result.name);
          // Should be all same character (e.g., "99999", "aaaa", "🔥🔥🔥")
          expect(isAllSameChar(label)).toBe(true);
        }
      });
    });
  });

  describe('Has Offer Filter', () => {
    it('hasOffer=true returns names with offers', async () => {
      const { data } = await search('filters[hasOffer]=true&limit=50');
      // May have no names with offers
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        expect(result.highest_offer_wei).not.toBeNull();
        expect(toBigInt(result.highest_offer_wei!)).toBeGreaterThan(0n);
      }
    });

    it('hasOffer=false returns names without offers', async () => {
      const { data } = await search('filters[hasOffer]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const hasOffer = result.highest_offer_wei != null && toBigInt(result.highest_offer_wei!) > 0n;
        expect(hasOffer).toBe(false);
      }
    });
  });

  describe('Offer Amount Filters', () => {
    it('minOffer filters to offers >= minimum offer amount', async () => {
      const minOffer = '100000000000000000'; // 0.1 ETH
      const { data } = await search(
        `filters[minOffer]=${minOffer}&limit=50`
      );
      // May have no names with offers >= minOffer
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        if (!result.highest_offer_wei) {
          failures.push(`${result.name}: no offer`);
          continue;
        }
        const offer = toBigInt(result.highest_offer_wei!);
        if (offer < BigInt(minOffer)) {
          failures.push(`${result.name}: offer ${offer} < ${minOffer}`);
        }
      }

      expect(failures, `Offer filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('maxOffer filters to offers <= maximum offer amount', async () => {
      const maxOffer = '10000000000000000000'; // 10 ETH
      const { data } = await search(
        `filters[hasOffer]=true&filters[maxOffer]=${maxOffer}&limit=50`
      );
      // May have no names with offers
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        if (!result.highest_offer_wei) {
          failures.push(`${result.name}: no offer (ES/DB drift)`);
          continue;
        }
        const offer = toBigInt(result.highest_offer_wei!);
        if (offer > BigInt(maxOffer)) {
          failures.push(`${result.name}: offer ${offer} > ${maxOffer}`);
        }
      }

      expect(failures, `Offer filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('minOffer + maxOffer filters to offer range', async () => {
      const minOffer = '100000000000000000'; // 0.1 ETH
      const maxOffer = '5000000000000000000'; // 5 ETH
      const { data } = await search(
        `filters[minOffer]=${minOffer}&filters[maxOffer]=${maxOffer}&limit=50`
      );
      // May have no names with offers in range
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        if (!result.highest_offer_wei) {
          failures.push(`${result.name}: no offer`);
          continue;
        }
        const offer = toBigInt(result.highest_offer_wei!);
        if (offer < BigInt(minOffer) || offer > BigInt(maxOffer)) {
          failures.push(`${result.name}: offer ${offer} not in range [${minOffer}, ${maxOffer}]`);
        }
      }

      expect(failures, `Offer filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });
  });

  describe('Listed Filter (Unified Listing Status)', () => {
    it('listed=true returns only names with active listings', async () => {
      const { data } = await search('filters[listed]=true&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const result of data!.results) {
        const hasActiveListing = result.listings?.some(
          (l) => l.status === 'active'
        );
        if (!hasActiveListing) {
          failures.push(`${result.name} (listings: ${result.listings?.length ?? 0})`);
        }
      }

      expect(failures, `Names without active listings: ${failures.join(', ')}`).toHaveLength(0);
    });

    it('listed=false returns only names without active listings', async () => {
      const { data } = await search('filters[listed]=false&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const hasActiveListing = result.listings?.some(
          (l) => l.status === 'active'
        );
        expect(hasActiveListing).toBeFalsy();
      }
    });
  });

  describe('Status Filter (Unified Expiration States)', () => {
    it('status=registered returns names with expiry > now', async () => {
      const { data } = await search('filters[status]=registered&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const now = Date.now();
      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        expect(new Date(result.expiry_date!).getTime()).toBeGreaterThan(now);
      }
    });

    it('status=grace returns names expired within 90 days', async () => {
      const { data } = await search('filters[status]=grace&limit=50');
      expect(
        data?.results.length,
        'status=grace returned 0 results - verify grace period names exist in database'
      ).toBeGreaterThan(0);

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeLessThanOrEqual(now);
        expect(expiry).toBeGreaterThan(ninetyDaysAgo);
      }
    });

    it('status=premium returns names expired 90-111 days ago', async () => {
      const { data } = await search('filters[status]=premium&limit=50');
      expect(
        data?.results.length,
        'status=premium returned 0 results - verify premium period names exist in database'
      ).toBeGreaterThan(0);

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
      const oneElevenDaysAgo = now - 111 * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeLessThanOrEqual(ninetyDaysAgo);
        expect(expiry).toBeGreaterThan(oneElevenDaysAgo);
      }
    });

    it('status=available returns names expired > 111 days ago', async () => {
      const { data } = await search('filters[status]=available&limit=50');
      expect(
        data?.results.length,
        'status=available returned 0 results - verify available names exist in database'
      ).toBeGreaterThan(0);

      const now = Date.now();
      const oneElevenDaysAgo = now - 111 * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeLessThanOrEqual(oneElevenDaysAgo);
      }
    });

    it('status[]=premium&status[]=available returns names in either status (OR logic)', async () => {
      const { data } = await search('filters[status][]=premium&filters[status][]=available&limit=50');
      expect(
        data?.results.length,
        'Multiple status filter returned 0 results - verify premium or available names exist'
      ).toBeGreaterThan(0);

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

      const failures: string[] = [];
      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();

        // Should be either premium (90-111 days ago) or available (>111 days ago)
        // Combined: expiry <= 90 days ago
        if (expiry > ninetyDaysAgo) {
          failures.push(`${result.name}: expiry ${result.expiry_date} is not in premium or available status`);
        }
      }

      expect(failures, `Status filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('status=premium,available (comma-separated) returns names in either status', async () => {
      const { data } = await search('filters[status]=premium,available&limit=50');
      expect(
        data?.results.length,
        'Comma-separated status filter returned 0 results - verify premium or available names exist'
      ).toBeGreaterThan(0);

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

      const failures: string[] = [];
      for (const result of data!.results) {
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();

        // Should be either premium (90-111 days ago) or available (>111 days ago)
        // Combined: expiry <= 90 days ago
        if (expiry > ninetyDaysAgo) {
          failures.push(`${result.name}: expiry ${result.expiry_date} is not in premium or available status`);
        }
      }

      expect(failures, `Status filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('multiple status filter combined with owner filter', async () => {
      // First get a name to find an owner address
      const { data: initial } = await search('filters[status]=premium&limit=1');
      if (!initial?.results.length || !initial.results[0].owner) {
        return; // Skip if no premium names with owners
      }

      const ownerAddress = initial.results[0].owner;
      const { data } = await search(
        `filters[owner]=${ownerAddress}&filters[status][]=premium&filters[status][]=available&limit=50`
      );

      // May have no results if owner has no premium/available names
      if (data?.results.length === 0) return;

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

      for (const result of data!.results) {
        // Check owner
        expect(result.owner?.toLowerCase()).toBe(ownerAddress.toLowerCase());

        // Check status (premium or available)
        expect(result.expiry_date).toBeDefined();
        const expiry = new Date(result.expiry_date!).getTime();
        expect(expiry).toBeLessThanOrEqual(ninetyDaysAgo);
      }
    });
  });

  describe('String Pattern Filters', () => {
    it('contains filter returns names containing exact substring', async () => {
      const substring = 'abc';
      const { data } = await search(`filters[contains]=${substring}&limit=50`);
      // May have no matching names
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label).toContain(substring.toLowerCase());
      }
    });

    it('startsWith filter returns names starting with prefix', async () => {
      const prefix = 'the';
      const { data } = await search(`filters[startsWith]=${prefix}&limit=50`);
      // May have no matching names
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label.startsWith(prefix.toLowerCase())).toBe(true);
      }
    });

    it('endsWith filter returns names ending with suffix (before .eth)', async () => {
      const suffix = 'dao';
      const { data } = await search(`filters[endsWith]=${suffix}&limit=50`);
      // May have no matching names
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label.endsWith(suffix.toLowerCase())).toBe(true);
      }
    });

    it('doesNotContain filter returns names NOT containing substring', async () => {
      const substring = 'a';
      const { data } = await search(`filters[doesNotContain]=${substring}&limit=50`);
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label).not.toContain(substring.toLowerCase());
      }
    });

    it('doesNotStartWith filter returns names NOT starting with prefix', async () => {
      const prefix = 'a';
      const { data } = await search(`filters[doesNotStartWith]=${prefix}&limit=50`);
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label.startsWith(prefix.toLowerCase())).toBe(false);
      }
    });

    it('doesNotEndWith filter returns names NOT ending with suffix (before .eth)', async () => {
      const suffix = 'a';
      const { data } = await search(`filters[doesNotEndWith]=${suffix}&limit=50`);
      expect(data?.results.length).toBeGreaterThan(0);

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label.endsWith(suffix.toLowerCase())).toBe(false);
      }
    });

    it('doesNotContain combined with contains filter', async () => {
      // Names containing "the" but not containing "ther"
      const { data } = await search(`filters[contains]=the&filters[doesNotContain]=ther&limit=50`);
      // May have no matching names
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label).toContain('the');
        expect(label).not.toContain('ther');
      }
    });

    it('doesNotStartWith combined with startsWith filter', async () => {
      // Names starting with "a" but not starting with "ab"
      const { data } = await search(`filters[startsWith]=a&filters[doesNotStartWith]=ab&limit=50`);
      // May have no matching names
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label.startsWith('a')).toBe(true);
        expect(label.startsWith('ab')).toBe(false);
      }
    });

    it('doesNotEndWith combined with endsWith filter', async () => {
      // Names ending with "n" but not ending with "on"
      const { data } = await search(`filters[endsWith]=n&filters[doesNotEndWith]=on&limit=50`);
      // May have no matching names
      if (data?.results.length === 0) return;

      for (const result of data!.results) {
        const label = getLabel(result.name).toLowerCase();
        expect(label.endsWith('n')).toBe(true);
        expect(label.endsWith('on')).toBe(false);
      }
    });
  });

  describe('Sorting', () => {
    it('sortBy=alphabetical&sortOrder=asc returns names in A-Z order', async () => {
      const { data } = await search('sortBy=alphabetical&sortOrder=asc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const names = data!.results.map((r) => r.name.toLowerCase());
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    it('sortBy=alphabetical&sortOrder=desc returns names in Z-A order', async () => {
      const { data } = await search('sortBy=alphabetical&sortOrder=desc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const names = data!.results.map((r) => r.name.toLowerCase());
      const sorted = [...names].sort().reverse();
      expect(names).toEqual(sorted);
    });

    it('sortBy=view_count&sortOrder=desc returns names ordered by most views first', async () => {
      const { data } = await search('sortBy=view_count&sortOrder=desc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const viewCounts = data!.results.map((r) => r.view_count);
      const sorted = [...viewCounts].sort((a, b) => b - a);
      expect(viewCounts).toEqual(sorted);
    }, 120000);

    it('sortBy=view_count&sortOrder=asc returns names ordered by least views first', async () => {
      const { data } = await search('sortBy=view_count&sortOrder=asc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const viewCounts = data!.results.map((r) => r.view_count);
      const sorted = [...viewCounts].sort((a, b) => a - b);
      expect(viewCounts).toEqual(sorted);
    }, 120000);

    it('sortBy=watchers_count&sortOrder=desc returns names ordered by most watchers first', async () => {
      const { data } = await search('sortBy=watchers_count&sortOrder=desc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const watchersCounts = data!.results.map((r) => r.watchers_count);
      const sorted = [...watchersCounts].sort((a, b) => b - a);
      expect(watchersCounts).toEqual(sorted);
    });

    it('sortBy=watchers_count&sortOrder=asc returns names ordered by least watchers first', async () => {
      const { data } = await search('sortBy=watchers_count&sortOrder=asc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const watchersCounts = data!.results.map((r) => r.watchers_count);
      const sorted = [...watchersCounts].sort((a, b) => a - b);
      expect(watchersCounts).toEqual(sorted);
    });

    it('sortBy=clubs_count&sortOrder=desc returns names ordered by most clubs first', async () => {
      const { data } = await search('sortBy=clubs_count&sortOrder=desc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const clubsCounts = data!.results.map((r) => r.clubs?.length ?? 0);
      const sorted = [...clubsCounts].sort((a, b) => b - a);
      expect(clubsCounts).toEqual(sorted);
    });

    it('sortBy=clubs_count&sortOrder=asc returns names ordered by least clubs first', async () => {
      const { data } = await search('sortBy=clubs_count&sortOrder=asc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      const clubsCounts = data!.results.map((r) => r.clubs?.length ?? 0);
      const sorted = [...clubsCounts].sort((a, b) => a - b);
      expect(clubsCounts).toEqual(sorted);
    });

    it('sortBy=clubs_count has alphabetical secondary sort for ties', async () => {
      const { data } = await search('sortBy=clubs_count&sortOrder=desc&limit=100');
      expect(data?.results.length).toBeGreaterThan(0);

      // Group results by clubs count
      const byClubsCount = new Map<number, string[]>();
      for (const result of data!.results) {
        const count = result.clubs?.length ?? 0;
        if (!byClubsCount.has(count)) {
          byClubsCount.set(count, []);
        }
        byClubsCount.get(count)!.push(result.name);
      }

      // For each group with more than one name, verify alphabetical order (ASCII byte order)
      for (const [count, names] of byClubsCount) {
        if (names.length > 1) {
          const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          expect(names).toEqual(sorted);
        }
      }
    });

    it('sortBy=offer&sortOrder=desc returns names ordered by highest offer first', async () => {
      const { data } = await search('sortBy=offer&sortOrder=desc&filters[hasOffer]=true&limit=50');
      // May have no names with offers
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      let prevOffer: bigint | null = null;

      for (const result of data!.results) {
        if (!result.highest_offer_wei) {
          failures.push(`${result.name}: no highest_offer_wei`);
          continue;
        }
        const currentOffer = toBigInt(result.highest_offer_wei!);
        if (prevOffer !== null && currentOffer > prevOffer) {
          failures.push(`${result.name}: offer ${currentOffer} > previous ${prevOffer} (should be descending)`);
        }
        prevOffer = currentOffer;
      }

      expect(failures, `Offer sort failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('sortBy=offer&sortOrder=asc returns names ordered by lowest offer first', async () => {
      const { data } = await search('sortBy=offer&sortOrder=asc&filters[hasOffer]=true&limit=50');
      // May have no names with offers
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      let prevOffer: bigint | null = null;

      for (const result of data!.results) {
        if (!result.highest_offer_wei) {
          failures.push(`${result.name}: no highest_offer_wei`);
          continue;
        }
        const currentOffer = toBigInt(result.highest_offer_wei!);
        if (prevOffer !== null && currentOffer < prevOffer) {
          failures.push(`${result.name}: offer ${currentOffer} < previous ${prevOffer} (should be ascending)`);
        }
        prevOffer = currentOffer;
      }

      expect(failures, `Offer sort failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('sortBy=offer without hasOffer filter places names without offers last (desc)', async () => {
      const { data } = await search('sortBy=offer&sortOrder=desc&limit=50');
      expect(data?.results.length).toBeGreaterThan(0);

      // Find the index where offers stop (first name without offer)
      let firstNoOfferIndex = -1;
      for (let i = 0; i < data!.results.length; i++) {
        const hasOffer = data!.results[i].highest_offer_wei != null &&
          BigInt(data!.results[i].highest_offer_wei!) > 0n;
        if (!hasOffer) {
          firstNoOfferIndex = i;
          break;
        }
      }

      // If we found names without offers, verify all subsequent names also have no offers
      if (firstNoOfferIndex !== -1) {
        for (let i = firstNoOfferIndex; i < data!.results.length; i++) {
          const hasOffer = data!.results[i].highest_offer_wei != null &&
            BigInt(data!.results[i].highest_offer_wei!) > 0n;
          expect(hasOffer).toBe(false);
        }
      }
    });
  });

  describe('Marketplace Filter', () => {
    it('marketplace=grails returns only names with Grails listings', async () => {
      // marketplace filter automatically implies listed=true
      const { data } = await search('filters[marketplace]=grails&limit=50');
      // May have no Grails listings
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const hasGrailsListing = result.listings?.some(
          (l) => l.status === 'active' && l.source === 'grails'
        );
        if (!hasGrailsListing) {
          const sources = result.listings?.map((l) => l.source).join(', ') ?? 'none';
          failures.push(`${result.name}: sources=[${sources}]`);
        }
      }

      expect(failures, `Names without Grails listings:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('marketplace=opensea returns only names with OpenSea listings', async () => {
      // marketplace filter automatically implies listed=true
      const { data } = await search('filters[marketplace]=opensea&limit=50');
      // May have no OpenSea listings
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const hasOpenseaListing = result.listings?.some(
          (l) => l.status === 'active' && l.source === 'opensea'
        );
        if (!hasOpenseaListing) {
          const sources = result.listings?.map((l) => l.source).join(', ') ?? 'none';
          failures.push(`${result.name}: sources=[${sources}]`);
        }
      }

      expect(failures, `Names without OpenSea listings:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('marketplace filter combined with other filters', async () => {
      // Test marketplace=grails with letters=only (no emoji or numbers)
      // marketplace filter automatically implies listed=true
      const { data } = await search(
        'filters[marketplace]=grails&filters[letters]=only&limit=50'
      );
      // May have no matching names
      if (data?.results.length === 0) return;

      const failures: string[] = [];
      for (const result of data!.results) {
        const label = getLabel(result.name);

        // Check marketplace
        const hasGrailsListing = result.listings?.some(
          (l) => l.status === 'active' && l.source === 'grails'
        );
        if (!hasGrailsListing) {
          failures.push(`${result.name}: no grails listing`);
        }

        // Check letters=only (no numbers or emoji)
        if (!/^[a-zA-Z]+$/.test(label)) {
          failures.push(`${result.name}: contains non-letters`);
        }
      }

      expect(failures, `Combined marketplace filter failures:\n${failures.join('\n')}`).toHaveLength(0);
    });
  });
});
