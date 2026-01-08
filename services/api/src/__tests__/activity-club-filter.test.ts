/**
 * Tests for Activity Club Filter
 *
 * Tests the club parameter for the global activity feed API endpoint.
 * WebSocket club subscription tests would require a WebSocket client setup.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

interface ActivityResponse {
  success: boolean;
  data?: {
    results: Array<{
      id: number;
      ens_name_id: number;
      event_type: string;
      actor_address: string;
      counterparty_address?: string;
      platform?: string;
      price_wei?: string;
      name: string;
      token_id?: string;
      created_at: string;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    timestamp: string;
  };
}

describe('Activity Club Filter API', () => {
  beforeAll(async () => {
    // Verify API is accessible (any response including 404 means server is alive)
    try {
      await fetch(`${API_BASE_URL}/health`);
    } catch (error) {
      throw new Error('API server not running. Start it with: npm run dev');
    }
  });

  describe('GET /api/v1/activity with club parameter', () => {
    it('should return activity for a valid club', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=999`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data?.results).toBeDefined();
      expect(Array.isArray(json.data?.results)).toBe(true);
      expect(json.data?.pagination).toBeDefined();
    });

    it('should return empty results for non-existent club', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=nonexistent_club_xyz`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data?.results).toBeDefined();
      expect(json.data?.results.length).toBe(0);
      expect(json.data?.pagination.total).toBe(0);
    });

    it('should combine club filter with event_type filter', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=999&event_type=sold`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();

      // All results should have event_type = 'sold'
      if (json.data && json.data.results.length > 0) {
        for (const result of json.data.results) {
          expect(result.event_type).toBe('sold');
        }
      }
    });

    it('should combine club filter with multiple event_types', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=999&event_type=sold&event_type=listed`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();

      // All results should have event_type in ['sold', 'listed']
      if (json.data && json.data.results.length > 0) {
        for (const result of json.data.results) {
          expect(['sold', 'listed']).toContain(result.event_type);
        }
      }
    });

    it('should combine club filter with pagination', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=999&page=1&limit=5`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data?.pagination.page).toBe(1);
      expect(json.data?.pagination.limit).toBe(5);
      expect(json.data?.results.length).toBeLessThanOrEqual(5);
    });

    it('should combine club filter with platform filter', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=999&platform=opensea`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();

      // All results should have platform = 'opensea'
      if (json.data && json.data.results.length > 0) {
        for (const result of json.data.results) {
          expect(result.platform).toBe('opensea');
        }
      }
    });

    it('should return all activity when no club filter', async () => {
      // Get activity without club filter
      const responseWithoutFilter = await fetch(`${API_BASE_URL}/api/v1/activity?limit=100`);
      const jsonWithoutFilter = (await responseWithoutFilter.json()) as ActivityResponse;

      // Get activity with club filter
      const responseWithFilter = await fetch(`${API_BASE_URL}/api/v1/activity?club=999&limit=100`);
      const jsonWithFilter = (await responseWithFilter.json()) as ActivityResponse;

      expect(jsonWithoutFilter.success).toBe(true);
      expect(jsonWithFilter.success).toBe(true);

      // Without filter should have >= results than with filter (or equal if all activity is in 999 club)
      expect(jsonWithoutFilter.data?.pagination.total).toBeGreaterThanOrEqual(
        jsonWithFilter.data?.pagination.total || 0
      );
    });

    it('should handle empty club parameter', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      // Empty club should be treated as no filter
      expect(json.data).toBeDefined();
    });
  });

  describe('Activity results structure', () => {
    it('should return proper activity record structure', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?limit=1`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);

      if (json.data && json.data.results.length > 0) {
        const result = json.data.results[0];

        // Check required fields exist
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('ens_name_id');
        expect(result).toHaveProperty('event_type');
        expect(result).toHaveProperty('actor_address');
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('created_at');
      }
    });

    it('should return pagination structure', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data?.pagination).toBeDefined();

      const pagination = json.data?.pagination;
      expect(pagination).toHaveProperty('page');
      expect(pagination).toHaveProperty('limit');
      expect(pagination).toHaveProperty('total');
      expect(pagination).toHaveProperty('totalPages');
      expect(pagination).toHaveProperty('hasNext');
      expect(pagination).toHaveProperty('hasPrev');
    });
  });

  describe('Club filter with different clubs', () => {
    const testClubs = ['999', '10k', '100k_club', 'single_ethmoji', 'prepunks'];

    for (const club of testClubs) {
      it(`should filter activity by club: ${club}`, async () => {
        const response = await fetch(`${API_BASE_URL}/api/v1/activity?club=${club}&limit=10`);
        expect(response.ok).toBe(true);

        const json = (await response.json()) as ActivityResponse;
        expect(json.success).toBe(true);
        expect(json.data).toBeDefined();
        expect(Array.isArray(json.data?.results)).toBe(true);
        // Results may be empty if no activity for that club
      });
    }
  });
});
