/**
 * Integration tests for the FE-focused name bundle endpoint.
 *
 * GET /api/v1/names/:name/bundle aggregates the three calls the name page
 * previously made individually:
 *   - GET /api/v1/names/:name                 -> data.details
 *   - GET /api/v1/offers/name/:name           -> data.offers
 *   - GET /api/v1/ens-roles/names/:name/roles -> data.roles
 *
 * These tests assert the bundle is shaped correctly and stays in parity with
 * the standalone endpoints.
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - THE_GRAPH_ENS_SUBGRAPH_URL configured
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_ROOT = 'http://localhost:3000/api/v1';

// Well-known name used across the existing test suite
const TEST_NAME = 'vitalik.eth';

interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta: {
    timestamp: string;
    version?: string;
  };
}

interface NameBundleData {
  details: any;
  offers: any[];
  roles: any | null;
}

async function getJSON<T>(path: string): Promise<{ status: number; data: APIResponse<T> }> {
  const response = await fetch(`${API_ROOT}${path}`);
  const data = (await response.json()) as APIResponse<T>;
  return { status: response.status, data };
}

describe('GET /names/:name/bundle', () => {
  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch(`${API_ROOT}/names/${TEST_NAME}/bundle`);
      if (!response) {
        throw new Error('No response received');
      }
    } catch (error: any) {
      if (error.message?.includes('fetch failed') || error.cause?.code === 'ECONNREFUSED') {
        throw new Error(
          'API server not running. Start with: cd services/api && npm run dev'
        );
      }
    }
  });

  it('returns details + offers + roles in one response', async () => {
    const { status, data } = await getJSON<NameBundleData>(`/names/${TEST_NAME}/bundle`);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBeDefined();

    const bundle = data.data!;
    // details
    expect(bundle.details).toBeDefined();
    expect(bundle.details.name).toBe(TEST_NAME);
    expect(typeof bundle.details.id).toBe('number');
    expect(Array.isArray(bundle.details.listings)).toBe(true);
    // offers
    expect(Array.isArray(bundle.offers)).toBe(true);
    // roles (object or null - tolerated)
    expect(bundle.roles === null || typeof bundle.roles === 'object').toBe(true);
  });

  it('details matches the standalone GET /names/:name', async () => {
    const [bundle, standalone] = await Promise.all([
      getJSON<NameBundleData>(`/names/${TEST_NAME}/bundle`),
      getJSON<any>(`/names/${TEST_NAME}`),
    ]);

    expect(bundle.status).toBe(200);
    expect(standalone.status).toBe(200);

    const a = bundle.data.data!.details;
    const b = standalone.data.data;
    // Invariant fields (view_count/metadata_updated_at can drift via async
    // view tracking / freshness, so we don't deep-equal the whole object).
    expect(a.id).toBe(b.id);
    expect(a.name).toBe(b.name);
    expect(a.token_id).toBe(b.token_id);
    expect(a.owner).toBe(b.owner);
  });

  it('roles matches the standalone GET /ens-roles/names/:name/roles', async () => {
    const [bundle, standalone] = await Promise.all([
      getJSON<NameBundleData>(`/names/${TEST_NAME}/bundle`),
      getJSON<any>(`/ens-roles/names/${TEST_NAME}/roles`),
    ]);

    expect(bundle.status).toBe(200);

    const bundleRoles = bundle.data.data!.roles;
    if (standalone.status === 200 && standalone.data.data) {
      expect(bundleRoles).not.toBeNull();
      expect(bundleRoles.name).toBe(standalone.data.data.name);
      expect(bundleRoles.owner).toBe(standalone.data.data.owner);
      expect(bundleRoles.isWrapped).toBe(standalone.data.data.isWrapped);
    }
  });

  it('offers matches the standalone GET /offers/name/:name (top 20 pending)', async () => {
    const [bundle, standalone] = await Promise.all([
      getJSON<NameBundleData>(`/names/${TEST_NAME}/bundle`),
      getJSON<{ offers: any[] }>(`/offers/name/${TEST_NAME}?status=pending&limit=20`),
    ]);

    expect(bundle.status).toBe(200);

    const bundleOffers = bundle.data.data!.offers;
    if (standalone.status === 200 && standalone.data.data) {
      const standaloneOffers = standalone.data.data.offers;
      expect(bundleOffers.length).toBe(standaloneOffers.length);
      expect(bundleOffers.map((o) => o.id)).toEqual(standaloneOffers.map((o) => o.id));
    }
  });

  it('honors offersLimit and offersStatus query params', async () => {
    const { status, data } = await getJSON<NameBundleData>(
      `/names/${TEST_NAME}/bundle?offersLimit=3&offersStatus=accepted`
    );

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data!.offers)).toBe(true);
    expect(data.data!.offers.length).toBeLessThanOrEqual(3);
  });

  it('returns 404 for a non-existent ENS name', async () => {
    const { status, data } = await getJSON<NameBundleData>(
      '/names/thisnamedoesnotexist12345xyz.eth/bundle'
    );

    expect(status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.error?.code).toBe('NAME_NOT_FOUND');
  });

  it('returns 400 for an invalid ENS name format', async () => {
    const { status, data } = await getJSON<NameBundleData>('/names/invalid/bundle');

    expect(status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error?.code).toBe('VALIDATION_ERROR');
  });

  it('includes proper meta information', async () => {
    const { data } = await getJSON<NameBundleData>(`/names/${TEST_NAME}/bundle`);

    expect(data.meta).toBeDefined();
    expect(data.meta.timestamp).toBeDefined();
    expect(new Date(data.meta.timestamp).getTime()).not.toBeNaN();
    expect(data.meta.version).toBe('1.0.0');
  });
});
