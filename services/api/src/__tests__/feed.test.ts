/**
 * Tests for the unified feed endpoint: GET /api/v1/feed
 *
 * Merges marketplace activity (activity_history) and user comments into a single
 * time-ordered, offset-paginated stream. These are integration tests and require
 * a running API server with a populated database:
 *   npm run dev   (in services/api)
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

interface FeedItem {
  kind: 'activity' | 'comment';
  id: number | string;
  ens_name_id: number;
  name: string;
  clubs?: string[] | null;
  owner_address?: string | null;
  created_at: string;
  activity?: {
    event_type: string;
    actor_address: string;
    counterparty_address?: string | null;
    platform?: string | null;
    chain_id?: number;
    price_wei?: string | null;
    currency_address?: string | null;
    transaction_hash?: string | null;
    block_number?: number | string | null;
    metadata?: Record<string, unknown>;
    token_id?: string | null;
  };
  comment?: {
    body: string;
    author_address: string;
  };
}

interface FeedResponse {
  success: boolean;
  data?: {
    results: FeedItem[];
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

const get = async (qs: string) => {
  const response = await fetch(`${API_BASE_URL}/api/v1/feed${qs}`);
  const json = (await response.json()) as FeedResponse;
  return { response, json };
};

describe('Unified Feed API (GET /api/v1/feed)', () => {
  beforeAll(async () => {
    try {
      await fetch(`${API_BASE_URL}/health`);
    } catch (error) {
      throw new Error('API server not running. Start it with: npm run dev');
    }
  });

  describe('Structure', () => {
    it('returns a success envelope with results + pagination', async () => {
      const { response, json } = await get('?limit=20');
      expect(response.ok).toBe(true);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data?.results)).toBe(true);

      const p = json.data?.pagination;
      expect(p).toBeDefined();
      for (const key of ['page', 'limit', 'total', 'totalPages', 'hasNext', 'hasPrev']) {
        expect(p).toHaveProperty(key);
      }
      // totalPages is floored at 1 (never 0).
      expect(p!.totalPages).toBeGreaterThanOrEqual(1);
    });

    it('each item carries a kind discriminator + matching nested object', async () => {
      const { json } = await get('?limit=50');
      for (const item of json.data?.results ?? []) {
        expect(['activity', 'comment']).toContain(item.kind);
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('name');
        expect(item).toHaveProperty('created_at');
        if (item.kind === 'activity') {
          expect(item.activity).toBeDefined();
          expect(item.activity).toHaveProperty('event_type');
          expect(item.comment).toBeUndefined();
        } else {
          expect(item.comment).toBeDefined();
          expect(item.comment).toHaveProperty('body');
          expect(item.comment).toHaveProperty('author_address');
          expect(item.activity).toBeUndefined();
        }
      }
    });

    it('orders the merged stream by created_at descending', async () => {
      const { json } = await get('?limit=100');
      const ts = (json.data?.results ?? []).map((r) => new Date(r.created_at).getTime());
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
      }
    });
  });

  describe('kinds selector', () => {
    it('kinds=activity returns only activity items', async () => {
      const { json } = await get('?kinds=activity&limit=50');
      expect(json.success).toBe(true);
      for (const item of json.data?.results ?? []) {
        expect(item.kind).toBe('activity');
      }
    });

    it('kinds=comment returns only comment items', async () => {
      const { json } = await get('?kinds=comment&limit=50');
      expect(json.success).toBe(true);
      for (const item of json.data?.results ?? []) {
        expect(item.kind).toBe('comment');
      }
    });

    it('rejects an invalid kinds value with 400', async () => {
      const { response, json } = await get('?kinds=bogus');
      expect(response.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Auto-scope rule', () => {
    it('an activity-only filter (no kinds) excludes comments', async () => {
      const { json } = await get('?event_type=sold&limit=50');
      expect(json.success).toBe(true);
      for (const item of json.data?.results ?? []) {
        expect(item.kind).toBe('activity');
        expect(item.activity?.event_type).toBe('sold');
      }
    });

    it('kinds=comment combined with an activity-only filter returns 400', async () => {
      const { response, json } = await get('?kinds=comment&platform=opensea');
      expect(response.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error?.code).toBe('VALIDATION_ERROR');
    });

    it('explicit kinds=activity,comment keeps comments even with an activity filter', async () => {
      const { json } = await get('?kinds=activity,comment&event_type=sold&limit=100');
      expect(json.success).toBe(true);
      // Comments are allowed through; activity rows still respect event_type.
      for (const item of json.data?.results ?? []) {
        if (item.kind === 'activity') expect(item.activity?.event_type).toBe('sold');
      }
    });
  });

  describe('Shared filters', () => {
    it('clubs=any succeeds', async () => {
      const { response, json } = await get('?clubs=any&limit=10');
      expect(response.ok).toBe(true);
      expect(json.success).toBe(true);
    });

    it('clubs comma-list succeeds', async () => {
      const { response, json } = await get('?clubs=10k,999&limit=10');
      expect(response.ok).toBe(true);
      expect(json.success).toBe(true);
    });

    it('rejects clubs=any mixed with specific clubs', async () => {
      const { response, json } = await get('?clubs=any,10k');
      expect(response.status).toBe(400);
      expect(json.error?.code).toBe('VALIDATION_ERROR');
    });

    it('owner filter succeeds and is structurally valid', async () => {
      const { response, json } = await get(
        '?owner=0x0000000000000000000000000000000000000000&limit=10'
      );
      expect(response.ok).toBe(true);
      expect(json.success).toBe(true);
    });

    it('rejects an invalid owner address', async () => {
      const { response, json } = await get('?owner=notanaddress');
      expect(response.status).toBe(400);
      expect(json.error?.code).toBe('VALIDATION_ERROR');
    });

    it('watchlist=true without auth returns 401', async () => {
      const { response, json } = await get('?watchlist=true');
      expect(response.status).toBe(401);
      expect(json.error?.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Exact counts', () => {
    it('combined total equals activity total + comment total (no activity filter)', async () => {
      const [{ json: both }, { json: act }, { json: com }] = await Promise.all([
        get('?limit=1'),
        get('?kinds=activity&limit=1'),
        get('?kinds=comment&limit=1'),
      ]);
      expect(both.success && act.success && com.success).toBe(true);
      expect(both.data?.pagination.total).toBe(
        (act.data?.pagination.total ?? 0) + (com.data?.pagination.total ?? 0)
      );
    });
  });

  describe('Pagination', () => {
    it('respects page/limit and produces no overlap across the boundary', async () => {
      const { json: p1 } = await get('?limit=5&page=1');
      const { json: p2 } = await get('?limit=5&page=2');
      expect(p1.data?.pagination.page).toBe(1);
      expect(p1.data?.pagination.limit).toBe(5);
      expect(p2.data?.pagination.page).toBe(2);
      expect(p1.data?.results.length).toBeLessThanOrEqual(5);

      const key = (i: FeedItem) => `${i.kind}:${i.id}`;
      const ids1 = new Set((p1.data?.results ?? []).map(key));
      for (const item of p2.data?.results ?? []) {
        expect(ids1.has(key(item))).toBe(false);
      }
    });
  });
});
