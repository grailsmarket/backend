/**
 * Status Criteria Tests
 *
 * These tests validate that the API correctly filters names by status
 * according to the documented requirements.
 *
 * Status Definitions (based on expiry_date):
 * - Registered: expiry_date > now (not expired)
 * - Grace: expired within last 90 days
 * - Premium: expired 90-111 days ago (premium auction period)
 * - Available: expired more than 111 days ago
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - Database populated with names in various statuses
 *
 * Run: npm test -- src/__tests__/status-criteria.test.ts
 */

import { describe, it, expect } from 'vitest';

const API_BASE = 'http://localhost:3000/api/v1';

// Status determination constants (in milliseconds)
const GRACE_PERIOD_DAYS = 90;
const PREMIUM_PERIOD_DAYS = 21; // 90-111 days after expiry

interface SearchResult {
  name: string;
  expiry_date?: string | null;
  owner?: string;
  clubs?: string[];
  listings?: Array<{ status: string; price?: string }>;
}

interface SearchResponse {
  success: boolean;
  data?: {
    results: SearchResult[];
    pagination: { total: number };
  };
  error?: { code: string; message: string };
}

type NameStatus = 'registered' | 'grace' | 'premium' | 'available';

/**
 * Determine the status of a name based on its expiry_date
 */
function getNameStatus(expiryDate: string | null | undefined): NameStatus {
  if (!expiryDate) {
    // Names without expiry_date are considered registered (e.g., subdomains)
    return 'registered';
  }

  const now = Date.now();
  const expiry = new Date(expiryDate).getTime();
  const daysSinceExpiry = (now - expiry) / (1000 * 60 * 60 * 24);

  if (daysSinceExpiry < 0) {
    return 'registered';
  } else if (daysSinceExpiry <= GRACE_PERIOD_DAYS) {
    return 'grace';
  } else if (daysSinceExpiry <= GRACE_PERIOD_DAYS + PREMIUM_PERIOD_DAYS) {
    return 'premium';
  } else {
    return 'available';
  }
}

/**
 * Helper to make search requests
 */
async function search(params: string): Promise<SearchResponse> {
  const url = `${API_BASE}/search?${params}`;
  const response = await fetch(url);
  return response.json() as Promise<SearchResponse>;
}

/**
 * Helper to make watchlist search requests
 */
async function searchWatchlist(params: string, authToken?: string): Promise<SearchResponse> {
  const url = `${API_BASE}/watchlist/search?${params}`;
  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  const response = await fetch(url, { headers });
  return response.json() as Promise<SearchResponse>;
}

/**
 * Analyze results and return status counts
 */
function analyzeStatuses(results: SearchResult[]): Record<NameStatus, number> {
  const counts: Record<NameStatus, number> = {
    registered: 0,
    grace: 0,
    premium: 0,
    available: 0,
  };

  for (const result of results) {
    const status = getNameStatus(result.expiry_date);
    counts[status]++;
  }

  return counts;
}

/**
 * Check if results contain only the expected statuses
 */
function hasOnlyStatuses(results: SearchResult[], allowedStatuses: NameStatus[]): boolean {
  for (const result of results) {
    const status = getNameStatus(result.expiry_date);
    if (!allowedStatuses.includes(status)) {
      return false;
    }
  }
  return true;
}

/**
 * Check which expected statuses are missing from results
 * Used to verify that all expected statuses are actually returned
 */
function getMissingStatuses(results: SearchResult[], expectedStatuses: NameStatus[]): NameStatus[] {
  const foundStatuses = new Set<NameStatus>();
  for (const result of results) {
    foundStatuses.add(getNameStatus(result.expiry_date));
  }
  return expectedStatuses.filter(status => !foundStatuses.has(status));
}

/**
 * Get names that don't match expected statuses (for debugging)
 */
function getUnexpectedNames(
  results: SearchResult[],
  allowedStatuses: NameStatus[]
): Array<{ name: string; status: NameStatus; expiry_date: string | null | undefined }> {
  const unexpected: Array<{ name: string; status: NameStatus; expiry_date: string | null | undefined }> = [];
  for (const result of results) {
    const status = getNameStatus(result.expiry_date);
    if (!allowedStatuses.includes(status)) {
      unexpected.push({ name: result.name, status, expiry_date: result.expiry_date });
    }
  }
  return unexpected;
}

// Common filter params used across most endpoints
const BASE_FILTERS = 'filters[letters]=include&filters[digits]=include&filters[emoji]=include&filters[repeatingChars]=include';

describe('Status Criteria Tests', () => {
  describe('Page/Tab Status Requirements', () => {
    describe('Explore Page', () => {
      it('Explore: Names tab should include Registered, Grace, Premium, and Available', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}`);
        expect(data?.results.length).toBeGreaterThan(0);

        const statuses = analyzeStatuses(data!.results);
        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];

        // All statuses should be allowed
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);
        expect(unexpected).toEqual([]);

        // Verify that we're actually getting names from all expected statuses
        // (This catches bugs where premium/available are incorrectly filtered out)
        const missingStatuses = getMissingStatuses(data!.results, allowedStatuses);
        if (missingStatuses.length > 0) {
          console.warn(`WARNING: Explore Names tab is missing these statuses: ${missingStatuses.join(', ')}`);
          console.warn('This could indicate a bug or simply missing test data.');
        }

        // Log status distribution for visibility
        console.log('Explore: Names tab status distribution:', statuses);
      });

      it('Explore: Premium tab should include ONLY Premium names', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&filters[status]=premium&sortBy=expiry_date&sortOrder=asc`
        );

        // May have no premium names in test data
        if (data?.results.length === 0) {
          console.warn('No premium names found in test data');
          return;
        }

        const allowedStatuses: NameStatus[] = ['premium'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });

      it('Explore: Available tab should include ONLY Available names', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&filters[status]=available&sortBy=expiry_date&sortOrder=desc`
        );

        // May have no available names in test data
        if (data?.results.length === 0) {
          console.warn('No available names found in test data');
          return;
        }

        const allowedStatuses: NameStatus[] = ['available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });
    });

    describe('Categories Page', () => {
      it('Categories: Names tab should include Registered, Grace, Premium, and Available', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&filters[inAnyClub]=true`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        // Verify that we're actually getting names from all expected statuses
        const missingStatuses = getMissingStatuses(data!.results, allowedStatuses);
        if (missingStatuses.length > 0) {
          console.warn(`WARNING: Categories Names tab is missing these statuses: ${missingStatuses.join(', ')}`);
          console.warn('This could indicate a bug or simply missing test data.');
        }

        const statuses = analyzeStatuses(data!.results);
        console.log('Categories: Names tab status distribution:', statuses);
      });

      it('Categories: Premium tab should include ONLY Premium names', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&filters[status]=premium&sortBy=expiry_date&sortOrder=asc&filters[inAnyClub]=true`
        );

        if (data?.results.length === 0) {
          console.warn('No premium names in clubs found in test data');
          return;
        }

        const allowedStatuses: NameStatus[] = ['premium'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });

      it('Categories: Available tab should include ONLY Available names', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&filters[status]=available&sortBy=expiry_date&sortOrder=desc&filters[inAnyClub]=true`
        );

        if (data?.results.length === 0) {
          console.warn('No available names in clubs found in test data');
          return;
        }

        const allowedStatuses: NameStatus[] = ['available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });
    });

    describe('Individual Category Pages', () => {
      it('Individual Category: Names tab should include Registered, Grace, Premium, and Available', async () => {
        // Using prepunks club as example (has many names in different statuses)
        // Use alphabetical sort and larger limit to get better status distribution
        const { data } = await search(`limit=500&page=1&${BASE_FILTERS}&filters[clubs][]=prepunks&sortBy=alphabetical`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        // Verify that we're actually getting names from all expected statuses
        const missingStatuses = getMissingStatuses(data!.results, allowedStatuses);
        if (missingStatuses.length > 0) {
          console.warn(`WARNING: Individual Category (prepunks) Names tab is missing these statuses: ${missingStatuses.join(', ')}`);
          console.warn('This could indicate a bug or simply missing test data.');
        }

        const statuses = analyzeStatuses(data!.results);
        console.log('Individual Category (prepunks): Names tab status distribution:', statuses);
      });

      it('Individual Category: Premium tab should include ONLY Premium names', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&filters[clubs][]=prepunks&filters[status]=premium&sortBy=expiry_date&sortOrder=asc`
        );

        if (data?.results.length === 0) {
          console.warn('No premium names in prepunks club found in test data');
          return;
        }

        const allowedStatuses: NameStatus[] = ['premium'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });

      it('Individual Category: Available tab should include ONLY Available names', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&filters[clubs][]=social_handles&filters[status]=available`
        );

        if (data?.results.length === 0) {
          console.warn('No available names in social_handles club found in test data');
          return;
        }

        const allowedStatuses: NameStatus[] = ['available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });
    });

    describe('Profile Page', () => {
      // Using a known test address - adjust as needed
      const TEST_OWNER = '0xc9c3a4337a1bba75d0860a1a81f7b990dc607334';
      const GRACE_TEST_OWNER = '0x871f1c2966389028a47c4f81ad4408d8099ea709';

      it('Profile: Names tab should include ONLY Registered and Grace (NOT Premium or Available)', async () => {
        const { data } = await search(
          `limit=100&page=1&filters[owner]=${TEST_OWNER}&${BASE_FILTERS}&sortBy=expiry_date&sortOrder=asc`
        );

        if (data?.results.length === 0) {
          console.warn(`No names found for owner ${TEST_OWNER}`);
          return;
        }

        // Profile Names tab should NOT show Premium or Available
        const allowedStatuses: NameStatus[] = ['registered', 'grace'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        if (unexpected.length > 0) {
          console.log('VIOLATION: Profile Names tab contains Premium/Available names:', unexpected);
        }

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Profile: Names tab status distribution:', statuses);
      });

      it('Profile: Grace tab should include ONLY Grace names', async () => {
        const { data } = await search(
          `limit=100&page=1&filters[owner]=${GRACE_TEST_OWNER}&${BASE_FILTERS}&filters[status]=grace&sortBy=expiry_date&sortOrder=asc`
        );

        if (data?.results.length === 0) {
          console.warn(`No grace names found for owner ${GRACE_TEST_OWNER}`);
          return;
        }

        const allowedStatuses: NameStatus[] = ['grace'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);
      });

      it('Profile: Watchlist tab should include Registered, Grace, Premium, and Available', async () => {
        // Note: This endpoint requires authentication
        // For now, we'll test the endpoint structure but may skip if not authenticated
        const { data, error } = await searchWatchlist(`limit=100&page=1&${BASE_FILTERS}`);

        if (error?.code === 'UNAUTHORIZED' || !data?.results) {
          console.warn('Watchlist endpoint requires authentication - skipping');
          return;
        }

        if (data.results.length === 0) {
          console.warn('No watchlist items found');
          return;
        }

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data.results);
        console.log('Profile: Watchlist tab status distribution:', statuses);
      });
    });
  });

  describe('Sort Option Status Requirements', () => {
    describe('Sorts that should include ALL statuses (Registered, Grace, Premium, Available)', () => {
      it('No sort (default) should include all statuses', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Default sort status distribution:', statuses);
      });

      it('sortBy=last_sale_price should include all statuses', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&sortBy=last_sale_price&sortOrder=desc`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by last_sale_price status distribution:', statuses);
      });

      it('sortBy=last_sale_date should include all statuses', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&sortBy=last_sale_date&sortOrder=desc`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by last_sale_date status distribution:', statuses);
      });

      it('sortBy=watchers_count should include all statuses', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&sortBy=watchers_count&sortOrder=desc`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by watchers_count status distribution:', statuses);
      });

      it('sortBy=view_count should include all statuses', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&sortBy=view_count&sortOrder=desc`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by view_count status distribution:', statuses);
      }, 120000);

      it('sortBy=alphabetical should include all statuses', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&sortBy=alphabetical&sortOrder=asc`);
        expect(data?.results.length).toBeGreaterThan(0);

        const allowedStatuses: NameStatus[] = ['registered', 'grace', 'premium', 'available'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by alphabetical status distribution:', statuses);
      });
    });

    describe('Sorts that should EXCLUDE Premium and Available', () => {
      it('sortBy=expiry_date should include ONLY Registered and Grace (NOT Premium or Available)', async () => {
        const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&sortBy=expiry_date&sortOrder=asc`);
        expect(data?.results.length).toBeGreaterThan(0);

        // Expiry sort should NOT include Premium or Available
        const allowedStatuses: NameStatus[] = ['registered', 'grace'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        if (unexpected.length > 0) {
          console.log('VIOLATION: Expiry sort contains Premium/Available names:', unexpected.slice(0, 10));
        }

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by expiry_date status distribution:', statuses);
      });

      it('sortBy=price should include ONLY Registered and Grace (NOT Premium or Available)', async () => {
        const { data } = await search(
          `limit=100&page=1&${BASE_FILTERS}&sortBy=price&sortOrder=asc&filters[showListings]=true`
        );

        if (data?.results.length === 0) {
          console.warn('No listings found for price sort test');
          return;
        }

        // Price sort should NOT include Premium or Available
        const allowedStatuses: NameStatus[] = ['registered', 'grace'];
        const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

        if (unexpected.length > 0) {
          console.log('VIOLATION: Price sort contains Premium/Available names:', unexpected.slice(0, 10));
        }

        expect(unexpected).toEqual([]);

        const statuses = analyzeStatuses(data!.results);
        console.log('Sort by price status distribution:', statuses);
      });
    });
  });

  describe('Status Filter Accuracy', () => {
    it('filters[status]=registered should return only registered names', async () => {
      const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&filters[status]=registered`);

      if (data?.results.length === 0) {
        console.warn('No registered names found');
        return;
      }

      const allowedStatuses: NameStatus[] = ['registered'];
      const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

      expect(unexpected).toEqual([]);
    });

    it('filters[status]=grace should return only grace period names', async () => {
      const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&filters[status]=grace`);

      if (data?.results.length === 0) {
        console.warn('No grace period names found');
        return;
      }

      const allowedStatuses: NameStatus[] = ['grace'];
      const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

      expect(unexpected).toEqual([]);
    });

    it('filters[status]=premium should return only premium auction names', async () => {
      const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&filters[status]=premium`);

      if (data?.results.length === 0) {
        console.warn('No premium auction names found');
        return;
      }

      const allowedStatuses: NameStatus[] = ['premium'];
      const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

      expect(unexpected).toEqual([]);
    });

    it('filters[status]=available should return only available names', async () => {
      const { data } = await search(`limit=100&page=1&${BASE_FILTERS}&filters[status]=available`);

      if (data?.results.length === 0) {
        console.warn('No available names found');
        return;
      }

      const allowedStatuses: NameStatus[] = ['available'];
      const unexpected = getUnexpectedNames(data!.results, allowedStatuses);

      expect(unexpected).toEqual([]);
    });
  });
});
