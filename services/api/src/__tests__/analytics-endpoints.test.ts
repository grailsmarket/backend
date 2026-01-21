import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface AnalyticsResponse<T> {
  success: boolean;
  data: {
    results: T[];
    pagination: PaginationInfo;
  };
  meta: {
    timestamp: string;
    version: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

interface SaleRecord {
  id: number;
  ens_name_id: number;
  seller_address: string;
  buyer_address: string;
  sale_price_wei: string;
  sale_date: string;
  name: string;
  token_id: string;
}

interface ListingRecord {
  id: number;
  ens_name_id: number;
  seller_address: string;
  price_wei: string;
  status: string;
  created_at: string;
  name: string;
  token_id: string;
}

interface OfferRecord {
  id: number;
  ens_name_id: number;
  buyer_address: string;
  offer_amount_wei: string;
  status: string;
  created_at: string;
  name: string;
  token_id: string;
}

async function fetchEndpoint<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  const data = await response.json();
  return data as T;
}

describe('Analytics Endpoints', () => {
  beforeAll(async () => {
    // Verify server is running (health endpoint is at root, not under /api/v1)
    try {
      const response = await fetch('http://localhost:3000/health');
      if (!response.ok) {
        throw new Error('API server not running');
      }
    } catch (error) {
      console.error('API server is not running. Please start it with: npm run dev');
      throw error;
    }
  });

  describe('GET /analytics/sales', () => {
    it('should return sales with default parameters', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>('/analytics/sales');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.results).toBeInstanceOf(Array);
      expect(result.data.pagination).toBeDefined();
      expect(result.data.pagination.page).toBe(1);
      expect(result.data.pagination.limit).toBe(20);
      expect(result.meta).toBeDefined();
      expect(result.meta.timestamp).toBeDefined();
    });

    it('should filter by period parameter', async () => {
      const periods = ['24h', '7d', '30d', '1y', 'all'];

      for (const period of periods) {
        const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
          `/analytics/sales?period=${period}`
        );
        expect(result.success).toBe(true);
        expect(result.data.results).toBeInstanceOf(Array);
      }
    });

    it('should sort by price ascending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?sortBy=price&sortOrder=asc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((s) => BigInt(s.sale_price_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] >= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should sort by price descending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?sortBy=price&sortOrder=desc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((s) => BigInt(s.sale_price_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] <= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should sort by date ascending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?sortBy=date&sortOrder=asc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const dates = result.data.results.map((s) => new Date(s.sale_date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i] >= dates[i - 1]).toBe(true);
        }
      }
    });

    it('should sort by date descending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?sortBy=date&sortOrder=desc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const dates = result.data.results.map((s) => new Date(s.sale_date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i] <= dates[i - 1]).toBe(true);
        }
      }
    });

    it('should paginate correctly', async () => {
      const page1 = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?page=1&limit=5'
      );

      expect(page1.success).toBe(true);
      expect(page1.data.pagination.page).toBe(1);
      expect(page1.data.pagination.limit).toBe(5);
      expect(page1.data.results.length).toBeLessThanOrEqual(5);

      if (page1.data.pagination.hasNext) {
        const page2 = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
          '/analytics/sales?page=2&limit=5'
        );
        expect(page2.success).toBe(true);
        expect(page2.data.pagination.page).toBe(2);
        expect(page2.data.pagination.hasPrev).toBe(true);

        // Ensure different results
        if (page1.data.results.length > 0 && page2.data.results.length > 0) {
          expect(page1.data.results[0].id).not.toBe(page2.data.results[0].id);
        }
      }
    });

    it('should limit results to max 100', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?limit=200'
      );

      expect(result.success).toBe(true);
      expect(result.data.pagination.limit).toBe(100);
    });

    it('should include ENS name data in results', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>('/analytics/sales?limit=5');

      expect(result.success).toBe(true);
      if (result.data.results.length > 0) {
        const sale = result.data.results[0];
        expect(sale.name).toBeDefined();
        expect(sale.token_id).toBeDefined();
      }
    });

    it('should filter by source=opensea', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?source=opensea'
      );

      expect(result.success).toBe(true);
      for (const sale of result.data.results) {
        expect((sale as any).source).toBe('opensea');
      }
    });

    it('should filter by source=grails', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?source=grails'
      );

      expect(result.success).toBe(true);
      for (const sale of result.data.results) {
        expect((sale as any).source).toBe('grails');
      }
    });

    it('should combine source filter with period', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<SaleRecord>>(
        '/analytics/sales?source=opensea&period=30d'
      );

      expect(result.success).toBe(true);
      for (const sale of result.data.results) {
        expect((sale as any).source).toBe('opensea');
      }
    });
  });

  describe('GET /analytics/listings', () => {
    it('should return listings with default parameters', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>('/analytics/listings');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.results).toBeInstanceOf(Array);
      expect(result.data.pagination).toBeDefined();
      expect(result.data.pagination.page).toBe(1);
      expect(result.data.pagination.limit).toBe(20);
    });

    it('should filter by period parameter', async () => {
      const periods = ['24h', '7d', '30d', '1y', 'all'];

      for (const period of periods) {
        const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
          `/analytics/listings?period=${period}`
        );
        expect(result.success).toBe(true);
        expect(result.data.results).toBeInstanceOf(Array);
      }
    });

    it('should filter by status=active', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?status=active'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect(listing.status).toBe('active');
      }
    });

    it('should filter by status=cancelled', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?status=cancelled'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect(listing.status).toBe('cancelled');
      }
    });

    it('should filter by status=sold', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?status=sold'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect(listing.status).toBe('sold');
      }
    });

    it('should sort by price ascending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?sortBy=price&sortOrder=asc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((l) => BigInt(l.price_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] >= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should sort by price descending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?sortBy=price&sortOrder=desc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((l) => BigInt(l.price_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] <= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should paginate correctly', async () => {
      const page1 = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?page=1&limit=5'
      );

      expect(page1.success).toBe(true);
      expect(page1.data.pagination.page).toBe(1);
      expect(page1.data.pagination.limit).toBe(5);
      expect(page1.data.results.length).toBeLessThanOrEqual(5);

      if (page1.data.pagination.hasNext) {
        const page2 = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
          '/analytics/listings?page=2&limit=5'
        );
        expect(page2.success).toBe(true);
        expect(page2.data.pagination.page).toBe(2);
      }
    });

    it('should combine status filter with period', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?status=active&period=30d'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect(listing.status).toBe('active');
      }
    });

    it('should combine status filter with sorting', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?status=active&sortBy=price&sortOrder=desc'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect(listing.status).toBe('active');
      }
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((l) => BigInt(l.price_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] <= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should include ENS name data in results', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?limit=5'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length > 0) {
        const listing = result.data.results[0];
        expect(listing.name).toBeDefined();
        expect(listing.token_id).toBeDefined();
      }
    });

    it('should filter by source=opensea', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?source=opensea'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect((listing as any).source).toBe('opensea');
      }
    });

    it('should filter by source=grails', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?source=grails'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect((listing as any).source).toBe('grails');
      }
    });

    it('should combine source and status filters', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<ListingRecord>>(
        '/analytics/listings?source=opensea&status=active'
      );

      expect(result.success).toBe(true);
      for (const listing of result.data.results) {
        expect((listing as any).source).toBe('opensea');
        expect(listing.status).toBe('active');
      }
    });
  });

  describe('GET /analytics/offers', () => {
    it('should return offers with default parameters', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>('/analytics/offers');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.results).toBeInstanceOf(Array);
      expect(result.data.pagination).toBeDefined();
      expect(result.data.pagination.page).toBe(1);
      expect(result.data.pagination.limit).toBe(20);
    });

    it('should filter by period parameter', async () => {
      const periods = ['24h', '7d', '30d', '1y', 'all'];

      for (const period of periods) {
        const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
          `/analytics/offers?period=${period}`
        );
        expect(result.success).toBe(true);
        expect(result.data.results).toBeInstanceOf(Array);
      }
    });

    it('should filter by status=pending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?status=pending'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect(offer.status).toBe('pending');
      }
    });

    it('should filter by status=active', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?status=active'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect(offer.status).toBe('active');
      }
    });

    it('should filter by status=cancelled', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?status=cancelled'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect(offer.status).toBe('cancelled');
      }
    });

    it('should filter by status=accepted', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?status=accepted'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect(offer.status).toBe('accepted');
      }
    });

    it('should sort by price ascending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?sortBy=price&sortOrder=asc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((o) => BigInt(o.offer_amount_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] >= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should sort by price descending', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?sortBy=price&sortOrder=desc'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((o) => BigInt(o.offer_amount_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] <= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should paginate correctly', async () => {
      const page1 = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?page=1&limit=5'
      );

      expect(page1.success).toBe(true);
      expect(page1.data.pagination.page).toBe(1);
      expect(page1.data.pagination.limit).toBe(5);
      expect(page1.data.results.length).toBeLessThanOrEqual(5);

      if (page1.data.pagination.hasNext) {
        const page2 = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
          '/analytics/offers?page=2&limit=5'
        );
        expect(page2.success).toBe(true);
        expect(page2.data.pagination.page).toBe(2);
      }
    });

    it('should combine status filter with period', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?status=active&period=30d'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect(offer.status).toBe('active');
      }
    });

    it('should combine status filter with sorting', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?status=active&sortBy=price&sortOrder=desc'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect(offer.status).toBe('active');
      }
      if (result.data.results.length >= 2) {
        const prices = result.data.results.map((o) => BigInt(o.offer_amount_wei));
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i] <= prices[i - 1]).toBe(true);
        }
      }
    });

    it('should include ENS name data in results', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?limit=5'
      );

      expect(result.success).toBe(true);
      if (result.data.results.length > 0) {
        const offer = result.data.results[0];
        expect(offer.name).toBeDefined();
        expect(offer.token_id).toBeDefined();
      }
    });

    it('should filter by source=opensea', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?source=opensea'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect((offer as any).source).toBe('opensea');
      }
    });

    it('should filter by source=grails', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?source=grails'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect((offer as any).source).toBe('grails');
      }
    });

    it('should combine source and status filters', async () => {
      const result = await fetchEndpoint<AnalyticsResponse<OfferRecord>>(
        '/analytics/offers?source=opensea&status=active'
      );

      expect(result.success).toBe(true);
      for (const offer of result.data.results) {
        expect((offer as any).source).toBe('opensea');
        expect(offer.status).toBe('active');
      }
    });
  });

  describe('Error handling', () => {
    // Note: Zod validation errors currently return 500 in this API
    // These tests verify that invalid params are rejected (not silently accepted)
    it('should reject invalid period for sales', async () => {
      const response = await fetch(`${API_BASE}/analytics/sales?period=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid period for listings', async () => {
      const response = await fetch(`${API_BASE}/analytics/listings?period=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid period for offers', async () => {
      const response = await fetch(`${API_BASE}/analytics/offers?period=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid status for listings', async () => {
      const response = await fetch(`${API_BASE}/analytics/listings?status=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid status for offers', async () => {
      const response = await fetch(`${API_BASE}/analytics/offers?status=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid sortBy for sales', async () => {
      const response = await fetch(`${API_BASE}/analytics/sales?sortBy=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid sortOrder for sales', async () => {
      const response = await fetch(`${API_BASE}/analytics/sales?sortOrder=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid source for sales', async () => {
      const response = await fetch(`${API_BASE}/analytics/sales?source=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid source for listings', async () => {
      const response = await fetch(`${API_BASE}/analytics/listings?source=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should reject invalid source for offers', async () => {
      const response = await fetch(`${API_BASE}/analytics/offers?source=invalid`);
      expect(response.ok).toBe(false);
    });
  });
});
