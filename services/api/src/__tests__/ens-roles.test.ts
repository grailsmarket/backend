/**
 * Integration tests for ENS Roles API endpoints
 *
 * Tests the ENS roles functionality which:
 * - Gets roles (owner, manager, ETH address) for ENS names
 * - Checks if an address can manage (update records for) a name
 * - Lists all names an address can manage
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - THE_GRAPH_ENS_SUBGRAPH_URL configured
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { decodeFuses, FUSES } from '../services/ens-roles';

const API_BASE = 'http://localhost:3000/api/v1/ens-roles';

// Known ENS names for testing
// vitalik.eth - well-known wrapped name
const TEST_WRAPPED_NAME = 'vitalik.eth';
const VITALIK_ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

// Known unwrapped name for testing (0xthrpw.eth from existing tests)
const TEST_UNWRAPPED_NAME = '0xthrpw.eth';

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

interface RolesResponse {
  name: string;
  owner: string | null;
  manager: string | null;
  ethAddress: string | null;
  isWrapped: boolean;
  fuses: {
    canUnwrap: boolean;
    canBurnFuses: boolean;
    canTransfer: boolean;
    canSetResolver: boolean;
    canSetTTL: boolean;
    canCreateSubdomain: boolean;
    parentCanControl: boolean;
    canExtendExpiry: boolean;
    raw: number;
  } | null;
  expiryDate: number | null;
  resolver: string | null;
}

interface CanManageResponse {
  canManage: boolean;
  role: 'owner' | 'manager' | 'both' | null;
  isWrapped: boolean;
  fuses: RolesResponse['fuses'];
}

interface ManageableNameSearchResult {
  // SearchResult fields
  id: number;
  name: string;
  token_id: string;
  owner: string;
  expiry_date: string | null;
  registration_date: string | null;
  last_sale_date: string | null;
  metadata: any;
  metadata_updated_at: string | null;
  clubs: string[] | null;
  has_numbers: boolean;
  has_emoji: boolean;
  last_sale_price: string | null;
  last_sale_currency: string | null;
  last_sale_price_usd: number | null;
  listings: any[];
  upvotes: number;
  downvotes: number;
  net_score: number;
  user_vote?: number | null;
  watchers_count: number;
  is_user_watching: boolean;
  watchlist_record_id: number | null;
  highest_offer_wei: string | null;
  highest_offer_currency: string | null;
  highest_offer_id: number | null;
  view_count: number;
  // Role field
  role: 'owner' | 'manager' | 'both';
}

interface ManageableNamesResponse {
  address: string;
  names: ManageableNameSearchResult[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Helper to make API requests
async function fetchAPI<T>(path: string): Promise<{ status: number; data: APIResponse<T> }> {
  const response = await fetch(`${API_BASE}${path}`);
  const data = await response.json() as APIResponse<T>;
  return { status: response.status, data };
}

describe('ENS Roles API', () => {
  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch(`${API_BASE}/names/test.eth/roles`);
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

  describe('GET /names/:name/roles', () => {
    it('returns roles for a known wrapped ENS name', async () => {
      const { status, data } = await fetchAPI<RolesResponse>(`/names/${TEST_WRAPPED_NAME}/roles`);

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      const roles = data.data!;
      expect(roles.name).toBe(TEST_WRAPPED_NAME);
      expect(roles.isWrapped).toBe(true);
      expect(roles.owner).toBeDefined();
      expect(roles.owner?.toLowerCase()).toBe(VITALIK_ADDRESS);
      // For wrapped names, manager equals owner
      expect(roles.manager).toBe(roles.owner);
      // Wrapped names should have fuses
      expect(roles.fuses).toBeDefined();
      expect(typeof roles.fuses?.raw).toBe('number');
    });

    it('returns roles for a known unwrapped ENS name', async () => {
      const { status, data } = await fetchAPI<RolesResponse>(`/names/${TEST_UNWRAPPED_NAME}/roles`);

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      const roles = data.data!;
      expect(roles.name).toBe(TEST_UNWRAPPED_NAME);
      // This name may be wrapped or unwrapped - verify structure is correct either way
      expect(typeof roles.isWrapped).toBe('boolean');
      expect(roles.owner).toBeDefined();
    });

    it('returns 404 for non-existent ENS name', async () => {
      const { status, data } = await fetchAPI<RolesResponse>('/names/thisnamedoesnotexist12345xyz.eth/roles');

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NAME_NOT_FOUND');
    });

    it('returns 400 for invalid ENS name format', async () => {
      const { status, data } = await fetchAPI<RolesResponse>('/names/invalid/roles');

      expect(status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('includes expiry date when available', async () => {
      const { status, data } = await fetchAPI<RolesResponse>(`/names/${TEST_WRAPPED_NAME}/roles`);

      expect(status).toBe(200);
      expect(data.data).toBeDefined();

      // Expiry date should be a Unix timestamp
      if (data.data!.expiryDate) {
        expect(typeof data.data!.expiryDate).toBe('number');
        expect(data.data!.expiryDate).toBeGreaterThan(0);
      }
    });

    it('includes resolver address when set', async () => {
      const { status, data } = await fetchAPI<RolesResponse>(`/names/${TEST_WRAPPED_NAME}/roles`);

      expect(status).toBe(200);
      expect(data.data).toBeDefined();

      // Resolver should be an address or null
      if (data.data!.resolver) {
        expect(data.data!.resolver).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });
  });

  describe('GET /names/:name/can-manage/:address', () => {
    it('returns true for owner address', async () => {
      const { status, data } = await fetchAPI<CanManageResponse>(
        `/names/${TEST_WRAPPED_NAME}/can-manage/${VITALIK_ADDRESS}`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      expect(data.data!.canManage).toBe(true);
      expect(['owner', 'both']).toContain(data.data!.role);
      expect(data.data!.isWrapped).toBe(true);
    });

    it('returns false for unrelated address', async () => {
      const unrelatedAddress = '0x0000000000000000000000000000000000000001';
      const { status, data } = await fetchAPI<CanManageResponse>(
        `/names/${TEST_WRAPPED_NAME}/can-manage/${unrelatedAddress}`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      expect(data.data!.canManage).toBe(false);
      expect(data.data!.role).toBeNull();
    });

    it('returns false for non-existent name', async () => {
      const { status, data } = await fetchAPI<CanManageResponse>(
        `/names/thisnamedoesnotexist12345xyz.eth/can-manage/${VITALIK_ADDRESS}`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      expect(data.data!.canManage).toBe(false);
      expect(data.data!.role).toBeNull();
    });

    it('returns 400 for invalid address format', async () => {
      const { status, data } = await fetchAPI<CanManageResponse>(
        `/names/${TEST_WRAPPED_NAME}/can-manage/invalid-address`
      );

      expect(status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('is case-insensitive for address matching', async () => {
      const upperAddress = VITALIK_ADDRESS.toUpperCase();
      const { status, data } = await fetchAPI<CanManageResponse>(
        `/names/${TEST_WRAPPED_NAME}/can-manage/${upperAddress}`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      // Should still match despite case difference
      expect(data.data!.canManage).toBe(true);
    });
  });

  describe('GET /users/:address/manageable-names', () => {
    it('returns list of manageable names with enriched SearchResult format', async () => {
      const { status, data } = await fetchAPI<ManageableNamesResponse>(
        `/users/${VITALIK_ADDRESS}/manageable-names`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      expect(data.data!.address).toBe(VITALIK_ADDRESS.toLowerCase());
      expect(Array.isArray(data.data!.names)).toBe(true);

      // Check pagination structure
      expect(data.data!.pagination).toBeDefined();
      expect(data.data!.pagination.page).toBe(1);
      expect(data.data!.pagination.limit).toBe(20);
      expect(typeof data.data!.pagination.total).toBe('number');
      expect(typeof data.data!.pagination.totalPages).toBe('number');
      expect(typeof data.data!.pagination.hasNext).toBe('boolean');
      expect(typeof data.data!.pagination.hasPrev).toBe('boolean');

      // vitalik.eth should be in the list with enriched fields
      const vitalikName = data.data!.names.find(n => n.name === TEST_WRAPPED_NAME);
      expect(vitalikName).toBeDefined();
      expect(['owner', 'manager', 'both']).toContain(vitalikName!.role);

      // Check SearchResult fields are present
      expect(typeof vitalikName!.id).toBe('number');
      expect(vitalikName!.token_id).toBeDefined();
      expect(vitalikName!.owner).toBeDefined();
      expect(Array.isArray(vitalikName!.listings)).toBe(true);
      expect(typeof vitalikName!.upvotes).toBe('number');
      expect(typeof vitalikName!.downvotes).toBe('number');
      expect(typeof vitalikName!.watchers_count).toBe('number');
      expect(typeof vitalikName!.view_count).toBe('number');
    });

    it('returns empty list for address with no names', async () => {
      const emptyAddress = '0x0000000000000000000000000000000000000001';
      const { status, data } = await fetchAPI<ManageableNamesResponse>(
        `/users/${emptyAddress}/manageable-names`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();

      expect(data.data!.address).toBe(emptyAddress.toLowerCase());
      expect(data.data!.names).toBeInstanceOf(Array);
      expect(data.data!.names.length).toBe(0);

      // Pagination should still be present
      expect(data.data!.pagination).toBeDefined();
      expect(data.data!.pagination.total).toBe(0);
      expect(data.data!.pagination.totalPages).toBe(0);
    });

    it('returns 400 for invalid address format', async () => {
      const { status, data } = await fetchAPI<ManageableNamesResponse>(
        '/users/invalid-address/manageable-names'
      );

      expect(status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('normalizes address to lowercase', async () => {
      const upperAddress = VITALIK_ADDRESS.toUpperCase();
      const { status, data } = await fetchAPI<ManageableNamesResponse>(
        `/users/${upperAddress}/manageable-names`
      );

      expect(status).toBe(200);
      expect(data.data!.address).toBe(VITALIK_ADDRESS.toLowerCase());
    });

    it('supports pagination parameters', async () => {
      const { status, data } = await fetchAPI<ManageableNamesResponse>(
        `/users/${VITALIK_ADDRESS}/manageable-names?page=1&limit=5`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data!.pagination.page).toBe(1);
      expect(data.data!.pagination.limit).toBe(5);
      // Should return at most 5 names
      expect(data.data!.names.length).toBeLessThanOrEqual(5);
    });

    it('returns hasPrev=true for page > 1', async () => {
      // First check if there are enough names to have a second page
      const firstPage = await fetchAPI<ManageableNamesResponse>(
        `/users/${VITALIK_ADDRESS}/manageable-names?limit=1`
      );

      if (firstPage.data.data!.pagination.total > 1) {
        const { status, data } = await fetchAPI<ManageableNamesResponse>(
          `/users/${VITALIK_ADDRESS}/manageable-names?page=2&limit=1`
        );

        expect(status).toBe(200);
        expect(data.data!.pagination.page).toBe(2);
        expect(data.data!.pagination.hasPrev).toBe(true);
      }
    });
  });

  describe('Response format', () => {
    it('includes proper meta information', async () => {
      const { data } = await fetchAPI<RolesResponse>(`/names/${TEST_WRAPPED_NAME}/roles`);

      expect(data.meta).toBeDefined();
      expect(data.meta.timestamp).toBeDefined();
      expect(new Date(data.meta.timestamp).getTime()).not.toBeNaN();
      expect(data.meta.version).toBe('1.0.0');
    });
  });
});

describe('Fuse Decoding', () => {
  it('decodes fuses with all permissions enabled', () => {
    const fuses = decodeFuses(0);

    expect(fuses.canUnwrap).toBe(true);
    expect(fuses.canBurnFuses).toBe(true);
    expect(fuses.canTransfer).toBe(true);
    expect(fuses.canSetResolver).toBe(true);
    expect(fuses.canSetTTL).toBe(true);
    expect(fuses.canCreateSubdomain).toBe(true);
    expect(fuses.parentCanControl).toBe(true);
    expect(fuses.canExtendExpiry).toBe(false); // This is a positive flag
    expect(fuses.raw).toBe(0);
  });

  it('decodes CANNOT_UNWRAP fuse', () => {
    const fuses = decodeFuses(FUSES.CANNOT_UNWRAP);

    expect(fuses.canUnwrap).toBe(false);
    expect(fuses.canBurnFuses).toBe(true);
  });

  it('decodes CANNOT_TRANSFER fuse', () => {
    const fuses = decodeFuses(FUSES.CANNOT_TRANSFER);

    expect(fuses.canTransfer).toBe(false);
    expect(fuses.canUnwrap).toBe(true);
  });

  it('decodes CANNOT_SET_RESOLVER fuse', () => {
    const fuses = decodeFuses(FUSES.CANNOT_SET_RESOLVER);

    expect(fuses.canSetResolver).toBe(false);
  });

  it('decodes CAN_EXTEND_EXPIRY fuse', () => {
    const fuses = decodeFuses(FUSES.CAN_EXTEND_EXPIRY);

    expect(fuses.canExtendExpiry).toBe(true);
  });

  it('decodes multiple fuses combined', () => {
    const combined = FUSES.CANNOT_UNWRAP | FUSES.CANNOT_TRANSFER | FUSES.CAN_EXTEND_EXPIRY;
    const fuses = decodeFuses(combined);

    expect(fuses.canUnwrap).toBe(false);
    expect(fuses.canTransfer).toBe(false);
    expect(fuses.canExtendExpiry).toBe(true);
    expect(fuses.canBurnFuses).toBe(true);
    expect(fuses.canSetResolver).toBe(true);
  });

  it('decodes PARENT_CANNOT_CONTROL fuse', () => {
    const fuses = decodeFuses(FUSES.PARENT_CANNOT_CONTROL);

    expect(fuses.parentCanControl).toBe(false);
  });

  it('preserves raw fuse value', () => {
    const rawValue = 12345;
    const fuses = decodeFuses(rawValue);

    expect(fuses.raw).toBe(rawValue);
  });
});
