/**
 * Tests for Activity Platform/Source Filter
 *
 * Tests the platform query parameter (single, repeated, comma-separated)
 * for the activity feed API endpoints.
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
  error?: { code: string; message: string };
  meta?: { timestamp: string };
}

describe('Activity Platform Filter API', () => {
  beforeAll(async () => {
    try {
      await fetch(`${API_BASE_URL}/health`);
    } catch (error) {
      throw new Error('API server not running. Start it with: npm run dev');
    }
  });

  describe('GET /api/v1/activity with platform parameter', () => {
    it('should accept a single platform value', async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/activity?platform=opensea&limit=20`);
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();

      for (const result of json.data?.results ?? []) {
        expect(result.platform).toBe('opensea');
      }
    });

    it('should accept repeated platform params (OR semantics)', async () => {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/activity?platform=opensea&platform=grails&limit=20`
      );
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);

      for (const result of json.data?.results ?? []) {
        expect(['opensea', 'grails']).toContain(result.platform);
      }
    });

    it('should accept comma-separated platform values (OR semantics)', async () => {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/activity?platform=opensea,grails&limit=20`
      );
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);

      for (const result of json.data?.results ?? []) {
        expect(['opensea', 'grails']).toContain(result.platform);
      }
    });

    it('should trim whitespace in comma-separated values', async () => {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/activity?platform=opensea%20,%20grails&limit=20`
      );
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);

      for (const result of json.data?.results ?? []) {
        expect(['opensea', 'grails']).toContain(result.platform);
      }
    });

    it('should treat empty platform as no filter', async () => {
      const [unfilteredRes, emptyRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/v1/activity?limit=100`),
        fetch(`${API_BASE_URL}/api/v1/activity?platform=&limit=100`),
      ]);
      const unfiltered = (await unfilteredRes.json()) as ActivityResponse;
      const empty = (await emptyRes.json()) as ActivityResponse;

      expect(unfiltered.success).toBe(true);
      expect(empty.success).toBe(true);
      expect(empty.data?.pagination.total).toBe(unfiltered.data?.pagination.total);
    });

    it('should return a subset when filtering vs. unfiltered total', async () => {
      const [unfilteredRes, filteredRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/v1/activity?limit=1`),
        fetch(`${API_BASE_URL}/api/v1/activity?platform=blockchain&limit=1`),
      ]);
      const unfiltered = (await unfilteredRes.json()) as ActivityResponse;
      const filtered = (await filteredRes.json()) as ActivityResponse;

      expect(unfiltered.success).toBe(true);
      expect(filtered.success).toBe(true);
      expect(unfiltered.data?.pagination.total ?? 0).toBeGreaterThanOrEqual(
        filtered.data?.pagination.total ?? 0
      );
    });
  });

  describe('GET /api/v1/activity/:name with platform parameter', () => {
    it('should accept comma-separated platforms on per-name route', async () => {
      // Pick a name that exists by sniffing the global feed; bail gracefully if none.
      const seedRes = await fetch(`${API_BASE_URL}/api/v1/activity?limit=1`);
      const seed = (await seedRes.json()) as ActivityResponse;
      const name = seed.data?.results[0]?.name;
      if (!name) return;

      const response = await fetch(
        `${API_BASE_URL}/api/v1/activity/${encodeURIComponent(name)}?platform=opensea,grails&limit=20`
      );
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);

      for (const result of json.data?.results ?? []) {
        expect(['opensea', 'grails']).toContain(result.platform);
      }
    });
  });

  describe('GET /api/v1/activity/address/:address with platform parameter', () => {
    it('should accept repeated platforms on per-address route', async () => {
      const seedRes = await fetch(`${API_BASE_URL}/api/v1/activity?limit=1`);
      const seed = (await seedRes.json()) as ActivityResponse;
      const address = seed.data?.results[0]?.actor_address;
      if (!address) return;

      const response = await fetch(
        `${API_BASE_URL}/api/v1/activity/address/${address}?platform=opensea&platform=grails&platform=blockchain&limit=20`
      );
      expect(response.ok).toBe(true);

      const json = (await response.json()) as ActivityResponse;
      expect(json.success).toBe(true);

      for (const result of json.data?.results ?? []) {
        expect(['opensea', 'grails', 'blockchain']).toContain(result.platform);
      }
    });
  });
});
