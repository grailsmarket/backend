/**
 * Integration tests for POST /api/v1/search/bulk-filters endpoint
 *
 * Tests the bulk search with filters functionality which:
 * - Accepts an array of search terms
 * - Applies filters during search (only returns matching terms)
 * - Supports sorting and pagination of filtered results
 * - Does NOT return placeholder objects for not-found terms
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - Elasticsearch and PostgreSQL populated with data
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'http://localhost:3000/api/v1/search/bulk-filters';

interface SearchResult {
  id: number;
  name: string;
  owner?: string;
  expiry_date?: string | null;
  last_sale_date?: string | null;
  clubs?: string[];
  listings?: Array<{ status: string; price?: string; source?: string }>;
  has_numbers?: boolean;
  has_emoji?: boolean;
  highest_offer_wei?: string | null;
  view_count: number;
  watchers_count: number;
}

interface BulkFiltersResponse {
  success: boolean;
  data?: {
    results: SearchResult[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
    stats: {
      inputTerms: number;
      matchedTerms: number;
    };
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

// Helper to make bulk-filters requests
async function bulkFiltersSearch(body: any): Promise<BulkFiltersResponse> {
  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<BulkFiltersResponse>;
}

// Helper to get label (name without .eth)
function getLabel(name: string): string {
  return name.replace(/\.eth$/, '');
}

describe('Bulk Filters Search API', () => {
  // Test terms - mix of likely existing and non-existing names
  const testTerms = ['vitalik', 'ethereum', 'opensea', 'nonexistent12345xyz'];

  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: ['test'] }),
      });
      if (!response.ok && response.status !== 400) {
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error: any) {
      if (error.message?.includes('fetch failed')) {
        throw new Error(
          'API server not running. Start with: cd services/api && npm run dev'
        );
      }
      throw error;
    }
  });

  describe('Basic Functionality', () => {
    it('returns results for valid terms', async () => {
      const { success, data } = await bulkFiltersSearch({
        terms: testTerms,
      });

      expect(success).toBe(true);
      expect(data).toBeDefined();
      expect(data?.results).toBeInstanceOf(Array);
      expect(data?.pagination).toBeDefined();
      expect(data?.stats).toBeDefined();
      expect(data?.stats.inputTerms).toBe(testTerms.length);
    });

    it('does not return placeholder objects for not-found terms', async () => {
      const { data } = await bulkFiltersSearch({
        terms: ['nonexistent12345xyz', 'anotherfakename9999'],
      });

      expect(data?.results).toHaveLength(0);
      expect(data?.stats.matchedTerms).toBe(0);
    });

    it('normalizes terms with and without .eth suffix', async () => {
      const { data: withSuffix } = await bulkFiltersSearch({
        terms: ['vitalik.eth'],
      });
      const { data: withoutSuffix } = await bulkFiltersSearch({
        terms: ['vitalik'],
      });

      // Both should return the same results
      expect(withSuffix?.stats.matchedTerms).toBe(withoutSuffix?.stats.matchedTerms);
    });

    it('handles case-insensitive terms', async () => {
      const { data: lowercase } = await bulkFiltersSearch({
        terms: ['vitalik'],
      });
      const { data: uppercase } = await bulkFiltersSearch({
        terms: ['VITALIK'],
      });
      const { data: mixedCase } = await bulkFiltersSearch({
        terms: ['ViTaLiK'],
      });

      expect(lowercase?.stats.matchedTerms).toBe(uppercase?.stats.matchedTerms);
      expect(lowercase?.stats.matchedTerms).toBe(mixedCase?.stats.matchedTerms);
    });
  });

  describe('Validation', () => {
    it('rejects empty terms array', async () => {
      const { success, error } = await bulkFiltersSearch({
        terms: [],
      });

      expect(success).toBe(false);
      expect(error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects missing terms field', async () => {
      const { success, error } = await bulkFiltersSearch({
        filters: { showListings: true },
      });

      expect(success).toBe(false);
      expect(error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid sortBy value', async () => {
      const { success, error } = await bulkFiltersSearch({
        terms: ['vitalik'],
        sortBy: 'invalid_sort',
      });

      expect(success).toBe(false);
      expect(error?.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid request with all parameters', async () => {
      const { success } = await bulkFiltersSearch({
        terms: ['vitalik', 'ethereum'],
        page: 1,
        limit: 10,
        sortBy: 'alphabetical',
        sortOrder: 'asc',
        filters: {
          minLength: 3,
        },
      });

      expect(success).toBe(true);
    });
  });

  describe('Listing Filters', () => {
    it('showListings=true returns only names with active listings', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { showListings: true },
      });

      // All results should have active listings
      for (const result of data?.results || []) {
        const hasActiveListing = result.listings?.some(l => l.status === 'active');
        expect(hasActiveListing, `${result.name} should have active listing`).toBe(true);
      }
    });

    it('showUnlisted=true returns only names without active listings', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { showUnlisted: true },
      });

      // All results should NOT have active listings
      for (const result of data?.results || []) {
        const hasActiveListing = result.listings?.some(l => l.status === 'active');
        expect(hasActiveListing, `${result.name} should not have active listing`).toBeFalsy();
      }
    });
  });

  describe('Price Filters', () => {
    it('minPrice filters to listings >= minimum price', async () => {
      const minPrice = '1000000000000000000'; // 1 ETH
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: {
          showListings: true,
          minPrice,
        },
      });

      for (const result of data?.results || []) {
        const listing = result.listings?.find(l => l.status === 'active');
        if (listing?.price) {
          const price = BigInt(listing.price);
          expect(price >= BigInt(minPrice), `${result.name}: price ${price} should be >= ${minPrice}`).toBe(true);
        }
      }
    });

    it('maxPrice filters to listings <= maximum price', async () => {
      const maxPrice = '10000000000000000000'; // 10 ETH
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: {
          showListings: true,
          maxPrice,
        },
      });

      for (const result of data?.results || []) {
        const listing = result.listings?.find(l => l.status === 'active');
        if (listing?.price) {
          const price = BigInt(listing.price);
          expect(price <= BigInt(maxPrice), `${result.name}: price ${price} should be <= ${maxPrice}`).toBe(true);
        }
      }
    });
  });

  describe('Length Filters', () => {
    it('minLength filters to names with label >= minimum length', async () => {
      const minLength = 5;
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { minLength },
      });

      for (const result of data?.results || []) {
        const label = getLabel(result.name);
        expect(label.length >= minLength, `${result.name}: length ${label.length} should be >= ${minLength}`).toBe(true);
      }
    });

    it('maxLength filters to names with label <= maximum length', async () => {
      const maxLength = 7;
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { maxLength },
      });

      for (const result of data?.results || []) {
        const label = getLabel(result.name);
        expect(label.length <= maxLength, `${result.name}: length ${label.length} should be <= ${maxLength}`).toBe(true);
      }
    });
  });

  describe('Club Filters', () => {
    it('clubs filter returns only names in specified clubs', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { clubs: ['999'] },
      });

      for (const result of data?.results || []) {
        expect(result.clubs?.includes('999'), `${result.name} should be in 999 club`).toBe(true);
      }
    });

    it('inAnyClub=true returns only names with club membership', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { inAnyClub: true },
      });

      for (const result of data?.results || []) {
        expect(result.clubs && result.clubs.length > 0, `${result.name} should have clubs`).toBe(true);
      }
    });
  });

  describe('Pagination', () => {
    it('paginates filtered results correctly', async () => {
      // First, get all results to know the total
      const { data: allData } = await bulkFiltersSearch({
        terms: testTerms,
        limit: 100,
      });

      if ((allData?.stats.matchedTerms || 0) > 1) {
        // Get first page with limit 1
        const { data: page1 } = await bulkFiltersSearch({
          terms: testTerms,
          page: 1,
          limit: 1,
        });

        expect(page1?.results).toHaveLength(1);
        expect(page1?.pagination.page).toBe(1);
        expect(page1?.pagination.hasNext).toBe(true);

        // Get second page
        const { data: page2 } = await bulkFiltersSearch({
          terms: testTerms,
          page: 2,
          limit: 1,
        });

        expect(page2?.results).toHaveLength(1);
        expect(page2?.pagination.page).toBe(2);
        expect(page2?.pagination.hasPrev).toBe(true);

        // Results should be different
        expect(page1?.results[0].name).not.toBe(page2?.results[0].name);
      }
    });

    it('returns correct total across pages', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        page: 1,
        limit: 1,
      });

      expect(data?.pagination.total).toBe(data?.stats.matchedTerms);
      expect(data?.pagination.totalPages).toBe(Math.ceil((data?.pagination.total || 0) / 1));
    });
  });

  describe('Sorting', () => {
    it('sortBy=alphabetical orders results alphabetically', async () => {
      const { data: ascData } = await bulkFiltersSearch({
        terms: testTerms,
        sortBy: 'alphabetical',
        sortOrder: 'asc',
      });

      const names = ascData?.results.map(r => r.name) || [];
      const sortedNames = [...names].sort();
      expect(names).toEqual(sortedNames);
    });

    it('sortBy=alphabetical desc orders results reverse alphabetically', async () => {
      const { data: descData } = await bulkFiltersSearch({
        terms: testTerms,
        sortBy: 'alphabetical',
        sortOrder: 'desc',
      });

      const names = descData?.results.map(r => r.name) || [];
      const sortedNames = [...names].sort().reverse();
      expect(names).toEqual(sortedNames);
    });

    it('sortBy=expiry_date orders by expiration date', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        sortBy: 'expiry_date',
        sortOrder: 'asc',
      });

      const results = data?.results || [];
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1].expiry_date;
        const curr = results[i].expiry_date;
        if (prev && curr) {
          expect(new Date(prev) <= new Date(curr), `${results[i - 1].name} should expire before ${results[i].name}`).toBe(true);
        }
      }
    });
  });

  describe('Combined Filters', () => {
    it('applies multiple filters together', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
        filters: {
          minLength: 5,
          maxLength: 10,
        },
      });

      for (const result of data?.results || []) {
        const label = getLabel(result.name);
        expect(label.length >= 5 && label.length <= 10, `${result.name}: length ${label.length} should be between 5-10`).toBe(true);
      }
    });

    it('filters reduce the result count', async () => {
      // Get unfiltered results
      const { data: unfiltered } = await bulkFiltersSearch({
        terms: testTerms,
      });

      // Get filtered results (only short names)
      const { data: filtered } = await bulkFiltersSearch({
        terms: testTerms,
        filters: { maxLength: 3 },
      });

      // Filtered should have same or fewer results
      expect((filtered?.stats.matchedTerms || 0) <= (unfiltered?.stats.matchedTerms || 0)).toBe(true);
    });
  });

  describe('Stats', () => {
    it('returns correct inputTerms count', async () => {
      const terms = ['a', 'b', 'c', 'd', 'e'];
      const { data } = await bulkFiltersSearch({ terms });

      expect(data?.stats.inputTerms).toBe(terms.length);
    });

    it('matchedTerms equals pagination total', async () => {
      const { data } = await bulkFiltersSearch({
        terms: testTerms,
      });

      expect(data?.stats.matchedTerms).toBe(data?.pagination.total);
    });
  });
});
