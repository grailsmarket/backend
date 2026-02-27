/**
 * Integration tests for clubs API filters, sorting, and search
 *
 * These tests hit the running API server and validate that results
 * match the expected filter/sort/search criteria.
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - PostgreSQL populated with clubs data
 * - Migration 0380 applied (time-based stats and classifications)
 * - Classifications set via set-club-classifications.ts script
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'http://localhost:3000/api/v1/clubs';

interface Club {
  name: string;
  description: string | null;
  member_count: number;
  floor_price_wei: string | null;
  floor_price_currency: string | null;
  total_sales_count: number;
  total_sales_volume_wei: string;
  sales_count_1y: number;
  sales_count_1mo: number;
  sales_count_1w: number;
  sales_volume_wei_1y: string;
  sales_volume_wei_1mo: string;
  sales_volume_wei_1w: string;
  total_reg_count: number;
  reg_count_1y: number;
  reg_count_1mo: number;
  reg_count_1w: number;
  registered_count: number;
  grace_count: number;
  listings_count: number;
  registered_percent: number;
  grace_percent: number;
  listings_percent: number;
  premium_count: number;
  available_count: number;
  premium_percent: number;
  available_percent: number;
  classifications: string[] | null;
  last_floor_update: string | null;
  last_sales_update: string | null;
  created_at: string;
  updated_at: string;
  holders_count: number;
  holders_ratio: number;
}

interface ClubsResponse {
  success: boolean;
  data?: {
    clubs: Club[];
    total: number;
  };
  error?: string;
}

// Helper to make clubs requests
async function getClubs(params: string = ''): Promise<ClubsResponse> {
  const url = params ? `${API_BASE}?${params}` : API_BASE;
  const response = await fetch(url);
  return response.json() as Promise<ClubsResponse>;
}

// Valid classifications for reference
const VALID_CLASSIFICATIONS = [
  'ethmojis',
  'digits',
  'palindromes',
  'prepunk',
  'geo',
  'letters',
] as const;

// Valid sort fields
const VALID_SORT_FIELDS = [
  'total_sales_volume_wei',
  'sales_volume_wei_1y',
  'sales_volume_wei_1mo',
  'sales_volume_wei_1w',
  'total_sales_count',
  'sales_count_1y',
  'sales_count_1mo',
  'sales_count_1w',
  'total_reg_count',
  'reg_count_1y',
  'reg_count_1mo',
  'reg_count_1w',
  'member_count',
  'floor_price_wei',
  'name',
] as const;

describe('Clubs API Filters, Sorting, and Search', () => {
  // Verify server is running and has data before tests
  beforeAll(async () => {
    try {
      const response = await fetch(API_BASE);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const data = await response.json() as ClubsResponse;
      if (!data.data?.clubs.length) {
        throw new Error('No clubs found in database');
      }
    } catch (error) {
      throw new Error(
        'API server not running or no clubs data. Start with: cd services/api && npm run dev'
      );
    }
  });

  describe('Default Response', () => {
    it('returns clubs with all expected fields', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const club = data!.clubs[0];
      // Verify new fields exist
      expect(club).toHaveProperty('sales_count_1y');
      expect(club).toHaveProperty('sales_count_1mo');
      expect(club).toHaveProperty('sales_count_1w');
      expect(club).toHaveProperty('sales_volume_wei_1y');
      expect(club).toHaveProperty('sales_volume_wei_1mo');
      expect(club).toHaveProperty('sales_volume_wei_1w');
      expect(club).toHaveProperty('total_reg_count');
      expect(club).toHaveProperty('reg_count_1y');
      expect(club).toHaveProperty('reg_count_1mo');
      expect(club).toHaveProperty('reg_count_1w');
      expect(club).toHaveProperty('classifications');
    });

    it('default sort is by total_sales_volume_wei descending', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(1);

      const volumes = data!.clubs.map((c) =>
        BigInt(c.total_sales_volume_wei || '0')
      );

      // Verify descending order
      for (let i = 1; i < volumes.length; i++) {
        expect(
          volumes[i - 1] >= volumes[i],
          `Club ${data!.clubs[i - 1].name} (${volumes[i - 1]}) should be >= ${data!.clubs[i].name} (${volumes[i]})`
        ).toBe(true);
      }
    });
  });

  describe('Classification Filters', () => {
    it('class[]=ethmojis returns only ethmoji clubs', async () => {
      const { data } = await getClubs('class[]=ethmojis');
      expect(
        data?.clubs.length,
        'No ethmoji clubs found - ensure classifications are set'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('ethmojis')) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without ethmojis classification:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('class[]=digits returns only digit clubs', async () => {
      const { data } = await getClubs('class[]=digits');
      expect(
        data?.clubs.length,
        'No digit clubs found - ensure classifications are set'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('digits')) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without digits classification:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('class[]=palindromes returns only palindrome clubs', async () => {
      const { data } = await getClubs('class[]=palindromes');
      expect(
        data?.clubs.length,
        'No palindrome clubs found - ensure classifications are set'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('palindromes')) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without palindromes classification:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('class[]=prepunk returns only prepunk clubs', async () => {
      const { data } = await getClubs('class[]=prepunk');
      expect(
        data?.clubs.length,
        'No prepunk clubs found - ensure classifications are set'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('prepunk')) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without prepunk classification:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('class[]=geo returns only geographic clubs', async () => {
      const { data } = await getClubs('class[]=geo');
      expect(
        data?.clubs.length,
        'No geo clubs found - ensure classifications are set'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('geo')) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without geo classification:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('class[]=letters returns only letter-based clubs', async () => {
      const { data } = await getClubs('class[]=letters');
      expect(
        data?.clubs.length,
        'No letters clubs found - ensure classifications are set'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('letters')) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without letters classification:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('multiple classifications filter with OR logic', async () => {
      const { data } = await getClubs('class[]=ethmojis&class[]=geo');
      expect(
        data?.clubs.length,
        'No ethmoji or geo clubs found'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        const hasEthmojis = club.classifications?.includes('ethmojis');
        const hasGeo = club.classifications?.includes('geo');
        if (!hasEthmojis && !hasGeo) {
          failures.push(`${club.name}: classifications=[${club.classifications?.join(', ') ?? 'null'}]`);
        }
      }

      expect(failures, `Clubs without ethmojis or geo:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('classification filter excludes clubs without that classification', async () => {
      // Get all clubs first
      const { data: allData } = await getClubs();
      const allClubNames = new Set(allData!.clubs.map((c) => c.name));

      // Get ethmoji clubs
      const { data: ethmojiData } = await getClubs('class[]=ethmojis');
      const ethmojiClubNames = new Set(ethmojiData!.clubs.map((c) => c.name));

      // Find a club that should NOT be in ethmoji results
      const nonEthmojiClub = allData!.clubs.find(
        (c) => !c.classifications?.includes('ethmojis') && c.classifications !== null
      );

      if (nonEthmojiClub) {
        expect(
          ethmojiClubNames.has(nonEthmojiClub.name),
          `${nonEthmojiClub.name} should not be in ethmoji results`
        ).toBe(false);
      }
    });
  });

  describe('Sorting - Volume Fields', () => {
    it('sortBy=total_sales_volume_wei&sortOrder=desc sorts by all-time volume descending', async () => {
      const { data } = await getClubs('sortBy=total_sales_volume_wei&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const volumes = data!.clubs.map((c) => BigInt(c.total_sales_volume_wei || '0'));
      for (let i = 1; i < volumes.length; i++) {
        expect(
          volumes[i - 1] >= volumes[i],
          `${data!.clubs[i - 1].name} (${volumes[i - 1]}) should be >= ${data!.clubs[i].name} (${volumes[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=total_sales_volume_wei&sortOrder=asc sorts by all-time volume ascending', async () => {
      const { data } = await getClubs('sortBy=total_sales_volume_wei&sortOrder=asc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const volumes = data!.clubs.map((c) => BigInt(c.total_sales_volume_wei || '0'));
      for (let i = 1; i < volumes.length; i++) {
        expect(
          volumes[i - 1] <= volumes[i],
          `${data!.clubs[i - 1].name} (${volumes[i - 1]}) should be <= ${data!.clubs[i].name} (${volumes[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=sales_volume_wei_1y&sortOrder=desc sorts by yearly volume descending', async () => {
      const { data } = await getClubs('sortBy=sales_volume_wei_1y&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const volumes = data!.clubs.map((c) => BigInt(c.sales_volume_wei_1y || '0'));
      for (let i = 1; i < volumes.length; i++) {
        expect(
          volumes[i - 1] >= volumes[i],
          `${data!.clubs[i - 1].name} (${volumes[i - 1]}) should be >= ${data!.clubs[i].name} (${volumes[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=sales_volume_wei_1mo&sortOrder=desc sorts by monthly volume descending', async () => {
      const { data } = await getClubs('sortBy=sales_volume_wei_1mo&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const volumes = data!.clubs.map((c) => BigInt(c.sales_volume_wei_1mo || '0'));
      for (let i = 1; i < volumes.length; i++) {
        expect(
          volumes[i - 1] >= volumes[i],
          `${data!.clubs[i - 1].name} (${volumes[i - 1]}) should be >= ${data!.clubs[i].name} (${volumes[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=sales_volume_wei_1w&sortOrder=desc sorts by weekly volume descending', async () => {
      const { data } = await getClubs('sortBy=sales_volume_wei_1w&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const volumes = data!.clubs.map((c) => BigInt(c.sales_volume_wei_1w || '0'));
      for (let i = 1; i < volumes.length; i++) {
        expect(
          volumes[i - 1] >= volumes[i],
          `${data!.clubs[i - 1].name} (${volumes[i - 1]}) should be >= ${data!.clubs[i].name} (${volumes[i]})`
        ).toBe(true);
      }
    });
  });

  describe('Sorting - Sales Count Fields', () => {
    it('sortBy=total_sales_count&sortOrder=desc sorts by all-time sales count descending', async () => {
      const { data } = await getClubs('sortBy=total_sales_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.total_sales_count);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=sales_count_1y&sortOrder=desc sorts by yearly sales count descending', async () => {
      const { data } = await getClubs('sortBy=sales_count_1y&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.sales_count_1y);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=sales_count_1mo&sortOrder=desc sorts by monthly sales count descending', async () => {
      const { data } = await getClubs('sortBy=sales_count_1mo&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.sales_count_1mo);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=sales_count_1w&sortOrder=desc sorts by weekly sales count descending', async () => {
      const { data } = await getClubs('sortBy=sales_count_1w&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.sales_count_1w);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });
  });

  describe('Sorting - Registration Count Fields', () => {
    it('sortBy=total_reg_count&sortOrder=desc sorts by all-time reg count descending', async () => {
      const { data } = await getClubs('sortBy=total_reg_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.total_reg_count);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=reg_count_1y&sortOrder=desc sorts by yearly reg count descending', async () => {
      const { data } = await getClubs('sortBy=reg_count_1y&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.reg_count_1y);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=reg_count_1mo&sortOrder=desc sorts by monthly reg count descending', async () => {
      const { data } = await getClubs('sortBy=reg_count_1mo&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.reg_count_1mo);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=reg_count_1w&sortOrder=desc sorts by weekly reg count descending', async () => {
      const { data } = await getClubs('sortBy=reg_count_1w&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.reg_count_1w);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });
  });

  describe('Sorting - Other Fields', () => {
    it('sortBy=member_count&sortOrder=desc sorts by member count descending', async () => {
      const { data } = await getClubs('sortBy=member_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.member_count);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=member_count&sortOrder=asc sorts by member count ascending', async () => {
      const { data } = await getClubs('sortBy=member_count&sortOrder=asc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.member_count);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] <= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be <= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=floor_price_wei&sortOrder=desc sorts by floor price descending', async () => {
      const { data } = await getClubs('sortBy=floor_price_wei&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      // Filter to clubs with floor prices for comparison
      const clubsWithFloor = data!.clubs.filter((c) => c.floor_price_wei !== null);
      if (clubsWithFloor.length > 1) {
        const prices = clubsWithFloor.map((c) => BigInt(c.floor_price_wei!));
        for (let i = 1; i < prices.length; i++) {
          expect(
            prices[i - 1] >= prices[i],
            `${clubsWithFloor[i - 1].name} (${prices[i - 1]}) should be >= ${clubsWithFloor[i].name} (${prices[i]})`
          ).toBe(true);
        }
      }
    });

    it('sortBy=name&sortOrder=asc sorts alphabetically A-Z', async () => {
      const { data } = await getClubs('sortBy=name&sortOrder=asc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const names = data!.clubs.map((c) => c.name.toLowerCase());
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    it('sortBy=name&sortOrder=desc sorts alphabetically Z-A', async () => {
      const { data } = await getClubs('sortBy=name&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const names = data!.clubs.map((c) => c.name.toLowerCase());
      const sorted = [...names].sort().reverse();
      expect(names).toEqual(sorted);
    });
  });

  describe('Sorting - Invalid Sort Fields', () => {
    it('invalid sort field falls back to default (total_sales_volume_wei)', async () => {
      const { data: invalidData } = await getClubs('sortBy=invalid_field&sortOrder=desc');
      const { data: defaultData } = await getClubs();

      expect(invalidData?.clubs.length).toBeGreaterThan(0);
      // Should match default ordering
      expect(invalidData!.clubs.map((c) => c.name)).toEqual(
        defaultData!.clubs.map((c) => c.name)
      );
    });
  });

  describe('Search', () => {
    it('search finds clubs by name (partial match)', async () => {
      const { data } = await getClubs('search=ethmoji');
      expect(
        data?.clubs.length,
        'No clubs found matching "ethmoji"'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        const nameMatch = club.name.toLowerCase().includes('ethmoji');
        const descMatch = club.description?.toLowerCase().includes('ethmoji');
        if (!nameMatch && !descMatch) {
          failures.push(`${club.name}: neither name nor description contains "ethmoji"`);
        }
      }

      expect(failures, `Search failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('search finds clubs by description (partial match)', async () => {
      const { data } = await getClubs('search=digit');
      expect(
        data?.clubs.length,
        'No clubs found matching "digit"'
      ).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        const nameMatch = club.name.toLowerCase().includes('digit');
        const descMatch = club.description?.toLowerCase().includes('digit');
        if (!nameMatch && !descMatch) {
          failures.push(`${club.name}: neither name nor description contains "digit"`);
        }
      }

      expect(failures, `Search failures:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('search is case-insensitive', async () => {
      const { data: lowerData } = await getClubs('search=prepunk');
      const { data: upperData } = await getClubs('search=PREPUNK');
      const { data: mixedData } = await getClubs('search=PrePunk');

      expect(lowerData?.clubs.length).toBeGreaterThan(0);
      expect(lowerData!.clubs.map((c) => c.name).sort()).toEqual(
        upperData!.clubs.map((c) => c.name).sort()
      );
      expect(lowerData!.clubs.map((c) => c.name).sort()).toEqual(
        mixedData!.clubs.map((c) => c.name).sort()
      );
    });

    it('search for non-existent term returns empty results', async () => {
      const { data } = await getClubs('search=xyz123nonexistent456');
      expect(data?.clubs.length).toBe(0);
    });

    it('search finds clubs by partial word in description', async () => {
      // Search for "country" which should match "countries" in descriptions
      const { data } = await getClubs('search=countr');
      expect(
        data?.clubs.length,
        'No clubs found matching "countr" (should match countries)'
      ).toBeGreaterThan(0);

      // Verify at least one result has "countr" in name or description
      const hasMatch = data!.clubs.some(
        (c) =>
          c.name.toLowerCase().includes('countr') ||
          c.description?.toLowerCase().includes('countr')
      );
      expect(hasMatch).toBe(true);
    });
  });

  describe('Combined Filters and Sort', () => {
    it('classification filter with custom sort', async () => {
      const { data } = await getClubs('class[]=digits&sortBy=member_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(0);

      // Verify all results have digits classification
      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (!club.classifications?.includes('digits')) {
          failures.push(`${club.name}: missing digits classification`);
        }
      }
      expect(failures).toHaveLength(0);

      // Verify sort order
      const counts = data!.clubs.map((c) => c.member_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] >= counts[i]).toBe(true);
      }
    });

    it('search with custom sort', async () => {
      const { data } = await getClubs('search=emoji&sortBy=total_sales_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(0);

      // Verify all results match search
      for (const club of data!.clubs) {
        const matches =
          club.name.toLowerCase().includes('emoji') ||
          club.description?.toLowerCase().includes('emoji');
        expect(matches).toBe(true);
      }

      // Verify sort order
      const counts = data!.clubs.map((c) => c.total_sales_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] >= counts[i]).toBe(true);
      }
    });

    it('classification filter with search', async () => {
      const { data } = await getClubs('class[]=digits&search=palindrome');
      expect(
        data?.clubs.length,
        'No digit palindrome clubs found'
      ).toBeGreaterThan(0);

      for (const club of data!.clubs) {
        // Must have digits classification
        expect(club.classifications).toContain('digits');

        // Must match search term
        const matches =
          club.name.toLowerCase().includes('palindrome') ||
          club.description?.toLowerCase().includes('palindrome');
        expect(matches).toBe(true);
      }
    });

    it('all parameters combined: filter + search + sort', async () => {
      const { data } = await getClubs(
        'class[]=letters&search=top&sortBy=member_count&sortOrder=desc'
      );
      // May have no results matching all criteria
      if (data?.clubs.length === 0) return;

      for (const club of data!.clubs) {
        // Must have letters classification
        expect(club.classifications).toContain('letters');

        // Must match search term
        const matches =
          club.name.toLowerCase().includes('top') ||
          club.description?.toLowerCase().includes('top');
        expect(matches).toBe(true);
      }

      // Verify sort order
      const counts = data!.clubs.map((c) => c.member_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] >= counts[i]).toBe(true);
      }
    });
  });

  describe('Time-Based Stats Consistency', () => {
    it('time-based counts are less than or equal to all-time counts', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (club.sales_count_1w > club.sales_count_1mo) {
          failures.push(`${club.name}: 1w count (${club.sales_count_1w}) > 1mo count (${club.sales_count_1mo})`);
        }
        if (club.sales_count_1mo > club.sales_count_1y) {
          failures.push(`${club.name}: 1mo count (${club.sales_count_1mo}) > 1y count (${club.sales_count_1y})`);
        }
        if (club.sales_count_1y > club.total_sales_count) {
          failures.push(`${club.name}: 1y count (${club.sales_count_1y}) > total count (${club.total_sales_count})`);
        }
      }

      expect(failures, `Time-based count inconsistencies:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('time-based registration counts are less than or equal to all-time counts', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (club.reg_count_1w > club.reg_count_1mo) {
          failures.push(`${club.name}: 1w reg count (${club.reg_count_1w}) > 1mo reg count (${club.reg_count_1mo})`);
        }
        if (club.reg_count_1mo > club.reg_count_1y) {
          failures.push(`${club.name}: 1mo reg count (${club.reg_count_1mo}) > 1y reg count (${club.reg_count_1y})`);
        }
        if (club.reg_count_1y > club.total_reg_count) {
          failures.push(`${club.name}: 1y reg count (${club.reg_count_1y}) > total reg count (${club.total_reg_count})`);
        }
      }

      expect(failures, `Time-based reg count inconsistencies:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('time-based volumes are less than or equal to all-time volumes', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        const vol1w = BigInt(club.sales_volume_wei_1w || '0');
        const vol1mo = BigInt(club.sales_volume_wei_1mo || '0');
        const vol1y = BigInt(club.sales_volume_wei_1y || '0');
        const volTotal = BigInt(club.total_sales_volume_wei || '0');

        if (vol1w > vol1mo) {
          failures.push(`${club.name}: 1w volume (${vol1w}) > 1mo volume (${vol1mo})`);
        }
        if (vol1mo > vol1y) {
          failures.push(`${club.name}: 1mo volume (${vol1mo}) > 1y volume (${vol1y})`);
        }
        if (vol1y > volTotal) {
          failures.push(`${club.name}: 1y volume (${vol1y}) > total volume (${volTotal})`);
        }
      }

      expect(failures, `Time-based volume inconsistencies:\n${failures.join('\n')}`).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('empty search string returns all clubs', async () => {
      const { data: emptySearch } = await getClubs('search=');
      const { data: noSearch } = await getClubs();

      expect(emptySearch!.clubs.length).toBe(noSearch!.clubs.length);
    });

    it('whitespace-only search returns all clubs', async () => {
      const { data: whitespaceSearch } = await getClubs('search=%20%20%20');
      const { data: noSearch } = await getClubs();

      // Trimmed whitespace should behave like no search
      expect(whitespaceSearch!.clubs.length).toBe(noSearch!.clubs.length);
    });

    it('invalid classification is ignored and returns all clubs', async () => {
      const { data: invalidClass } = await getClubs('class[]=invalid_class');
      const { data: noFilter } = await getClubs();
      // Invalid classifications are filtered out, so query proceeds without filter
      expect(invalidClass!.clubs.length).toBe(noFilter!.clubs.length);
    });

    it('mix of valid and invalid classifications only uses valid ones', async () => {
      const { data: mixed } = await getClubs('class[]=fake1&class[]=ethmojis');
      const { data: validOnly } = await getClubs('class[]=ethmojis');
      // Invalid classification is filtered out, valid one is used
      expect(mixed!.clubs.length).toBe(validOnly!.clubs.length);
      expect(mixed!.clubs.length).toBeGreaterThan(0);
      for (const club of mixed!.clubs) {
        expect(club.classifications).toContain('ethmojis');
      }
    });
  });

  describe('Holders Count and Ratio', () => {
    it('all clubs have holders_count field', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      for (const club of data!.clubs) {
        expect(club.holders_count).toBeDefined();
        expect(typeof club.holders_count).toBe('number');
        expect(club.holders_count).toBeGreaterThanOrEqual(0);
      }
    });

    it('all clubs have holders_ratio field', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      for (const club of data!.clubs) {
        expect(club.holders_ratio).toBeDefined();
        expect(typeof club.holders_ratio).toBe('number');
        expect(club.holders_ratio).toBeGreaterThanOrEqual(0);
      }
    });

    it('holders_count is less than or equal to member_count', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (club.holders_count > club.member_count) {
          failures.push(
            `${club.name}: holders_count (${club.holders_count}) > member_count (${club.member_count})`
          );
        }
      }
      expect(failures, `Holders count exceeded member count:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('holders_ratio is correctly calculated as (holders_count / member_count) * 100', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (club.member_count === 0) continue; // Skip clubs with no members

        const expectedRatio = Math.round((club.holders_count / club.member_count) * 100 * 100) / 100;
        // Allow for small floating point differences
        if (Math.abs(club.holders_ratio - expectedRatio) > 0.01) {
          failures.push(
            `${club.name}: holders_ratio (${club.holders_ratio}) != expected (${expectedRatio})`
          );
        }
      }
      expect(failures, `Holders ratio calculation errors:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('sortBy=holders_count&sortOrder=desc sorts by holders count descending', async () => {
      const { data } = await getClubs('sortBy=holders_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.holders_count);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] >= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be >= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=holders_count&sortOrder=asc sorts by holders count ascending', async () => {
      const { data } = await getClubs('sortBy=holders_count&sortOrder=asc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.holders_count);
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i - 1] <= counts[i],
          `${data!.clubs[i - 1].name} (${counts[i - 1]}) should be <= ${data!.clubs[i].name} (${counts[i]})`
        ).toBe(true);
      }
    });

    it('sortBy=holders_ratio&sortOrder=desc sorts by holders ratio descending', async () => {
      const { data } = await getClubs('sortBy=holders_ratio&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const ratios = data!.clubs.map((c) => c.holders_ratio);
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i - 1] >= ratios[i],
          `${data!.clubs[i - 1].name} (${ratios[i - 1]}%) should be >= ${data!.clubs[i].name} (${ratios[i]}%)`
        ).toBe(true);
      }
    });

    it('sortBy=holders_ratio&sortOrder=asc sorts by holders ratio ascending', async () => {
      const { data } = await getClubs('sortBy=holders_ratio&sortOrder=asc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const ratios = data!.clubs.map((c) => c.holders_ratio);
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i - 1] <= ratios[i],
          `${data!.clubs[i - 1].name} (${ratios[i - 1]}%) should be <= ${data!.clubs[i].name} (${ratios[i]}%)`
        ).toBe(true);
      }
    });
  });

  describe('Registered, Grace, and Listings Counts', () => {
    it('all clubs have registered_count, grace_count, and listings_count fields', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      for (const club of data!.clubs) {
        expect(club.registered_count).toBeDefined();
        expect(typeof club.registered_count).toBe('number');
        expect(club.registered_count).toBeGreaterThanOrEqual(0);

        expect(club.grace_count).toBeDefined();
        expect(typeof club.grace_count).toBe('number');
        expect(club.grace_count).toBeGreaterThanOrEqual(0);

        expect(club.listings_count).toBeDefined();
        expect(typeof club.listings_count).toBe('number');
        expect(club.listings_count).toBeGreaterThanOrEqual(0);
      }
    });

    it('all clubs have registered_percent, grace_percent, and listings_percent fields', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      for (const club of data!.clubs) {
        expect(club.registered_percent).toBeDefined();
        expect(typeof club.registered_percent).toBe('number');
        expect(club.registered_percent).toBeGreaterThanOrEqual(0);

        expect(club.grace_percent).toBeDefined();
        expect(typeof club.grace_percent).toBe('number');
        expect(club.grace_percent).toBeGreaterThanOrEqual(0);

        expect(club.listings_percent).toBeDefined();
        expect(typeof club.listings_percent).toBe('number');
        expect(club.listings_percent).toBeGreaterThanOrEqual(0);
      }
    });

    it('registered_count + grace_count + premium_count + available_count equals member_count', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        const total = club.registered_count + club.grace_count + club.premium_count + club.available_count;
        if (total !== club.member_count) {
          failures.push(
            `${club.name}: sum (${total}) != member_count (${club.member_count})`
          );
        }
      }
      expect(failures, `Status counts don't add up to member_count:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('listings_count is less than or equal to member_count', async () => {
      const { data } = await getClubs();
      expect(data?.clubs.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const club of data!.clubs) {
        if (club.listings_count > club.member_count) {
          failures.push(
            `${club.name}: listings_count (${club.listings_count}) > member_count (${club.member_count})`
          );
        }
      }
      expect(failures, `Listings count exceeded member count:\n${failures.join('\n')}`).toHaveLength(0);
    });

    it('sortBy=registered_count&sortOrder=desc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=registered_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.registered_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] >= counts[i]).toBe(true);
      }
    });

    it('sortBy=registered_count&sortOrder=asc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=registered_count&sortOrder=asc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.registered_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] <= counts[i]).toBe(true);
      }
    });

    it('sortBy=grace_count&sortOrder=desc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=grace_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.grace_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] >= counts[i]).toBe(true);
      }
    });

    it('sortBy=listings_count&sortOrder=desc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=listings_count&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const counts = data!.clubs.map((c) => c.listings_count);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1] >= counts[i]).toBe(true);
      }
    });

    it('sortBy=registered_percent&sortOrder=desc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=registered_percent&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const percents = data!.clubs.map((c) => c.registered_percent);
      for (let i = 1; i < percents.length; i++) {
        expect(percents[i - 1] >= percents[i]).toBe(true);
      }
    });

    it('sortBy=grace_percent&sortOrder=desc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=grace_percent&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const percents = data!.clubs.map((c) => c.grace_percent);
      for (let i = 1; i < percents.length; i++) {
        expect(percents[i - 1] >= percents[i]).toBe(true);
      }
    });

    it('sortBy=listings_percent&sortOrder=desc sorts correctly', async () => {
      const { data } = await getClubs('sortBy=listings_percent&sortOrder=desc');
      expect(data?.clubs.length).toBeGreaterThan(1);

      const percents = data!.clubs.map((c) => c.listings_percent);
      for (let i = 1; i < percents.length; i++) {
        expect(percents[i - 1] >= percents[i]).toBe(true);
      }
    });
  });
});
