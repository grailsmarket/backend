/**
 * Integration tests for brokered listings API
 *
 * These tests validate the brokered listings endpoints including:
 * - Configuration endpoint
 * - Create brokered listing with validation
 * - Query listings by broker address
 * - Statistics endpoint
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - PostgreSQL with migrations applied
 * - BROKER_MIN_FEE_BASIS_POINTS env var (default: 100 = 1%)
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const API_BASE = 'http://localhost:3000/api/v1/brokered-listings';

// Test addresses (checksummed format) - use clearly fake addresses for easy cleanup
const TEST_SELLER = '0x1234567890123456789012345678901234567890';
const TEST_BROKER = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';
const TEST_TOKEN_ID = '12345678901234567890123456789012345678901234567890123456789012345';

// Track created listing IDs for cleanup
const createdListingIds: number[] = [];

// Test seller addresses used in tests (for cleanup)
const TEST_SELLER_ADDRESSES = [
  '0x1234567890123456789012345678901234567890',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
];

// Helper to get database pool
async function getPool() {
  const { Pool } = await import('pg');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
}

// Helper to clean up test data via direct database connection
async function cleanupTestListings(): Promise<void> {
  try {
    const pool = await getPool();

    // Delete listings created by test seller addresses with broker_address set
    await pool.query(`
      DELETE FROM listings
      WHERE seller_address = ANY($1)
      AND broker_address IS NOT NULL
    `, [TEST_SELLER_ADDRESSES]);

    // Also clean up any ENS names created for test tokens
    await pool.query(`
      DELETE FROM ens_names
      WHERE token_id LIKE '123456789%'
    `);

    await pool.end();
  } catch (error) {
    console.warn('Test cleanup failed (non-critical):', error);
  }
}

// Helper to create test ENS name records in the database
async function createTestEnsNames(): Promise<void> {
  try {
    const pool = await getPool();

    // Create ENS name records for all the test token IDs we'll use
    // Use unique names based on full token_id to avoid duplicate name constraint
    const testTokenIds = [
      TEST_TOKEN_ID,          // Base test token
      TEST_TOKEN_ID + '1',    // For minimum fee test
      TEST_TOKEN_ID + '2',    // For address normalization test
      TEST_TOKEN_ID + '3',    // For large fee test
      TEST_TOKEN_ID + '4',    // For complex consideration test
      TEST_TOKEN_ID + '5',    // For duplicate order_hash test
    ];

    for (const tokenId of testTokenIds) {
      // Use full token_id in name to ensure uniqueness (name column has unique constraint)
      const uniqueName = `brokertest-${tokenId.slice(-12)}.eth`;
      await pool.query(`
        INSERT INTO ens_names (token_id, name, owner_address, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT (token_id) DO UPDATE SET
          name = EXCLUDED.name,
          owner_address = EXCLUDED.owner_address,
          updated_at = NOW()
      `, [tokenId, uniqueName, TEST_SELLER.toLowerCase()]);
    }

    await pool.end();
  } catch (error) {
    console.warn('Failed to create test ENS names:', error);
    throw error;
  }
}

// Helper to create a mock Seaport order with broker consideration
function createMockOrderData(options: {
  sellerAddress: string;
  brokerAddress: string;
  brokerFeeWei: string;
  platformFeeAddress?: string;
  platformFeeWei?: string;
  priceWei?: string;
}): string {
  const priceWei = options.priceWei || '1000000000000000000'; // 1 ETH default

  const consideration = [
    // Seller receives the remainder
    {
      itemType: 0, // NATIVE (ETH)
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: priceWei,
      endAmount: priceWei,
      recipient: options.sellerAddress.toLowerCase(),
    },
  ];

  // Add platform fee if specified
  if (options.platformFeeAddress && options.platformFeeWei) {
    consideration.push({
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: options.platformFeeWei,
      endAmount: options.platformFeeWei,
      recipient: options.platformFeeAddress.toLowerCase(),
    });
  }

  // Add broker fee
  consideration.push({
    itemType: 0,
    token: '0x0000000000000000000000000000000000000000',
    identifierOrCriteria: '0',
    startAmount: options.brokerFeeWei,
    endAmount: options.brokerFeeWei,
    recipient: options.brokerAddress.toLowerCase(),
  });

  const order = {
    parameters: {
      offerer: options.sellerAddress.toLowerCase(),
      zone: '0x0000000000000000000000000000000000000000',
      offer: [
        {
          itemType: 2, // ERC721
          token: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', // ENS Registrar
          identifierOrCriteria: TEST_TOKEN_ID,
          startAmount: '1',
          endAmount: '1',
        },
      ],
      consideration,
      orderType: 0,
      startTime: Math.floor(Date.now() / 1000).toString(),
      endTime: (Math.floor(Date.now() / 1000) + 86400 * 7).toString(), // 7 days
      zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      salt: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
      conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
      totalOriginalConsiderationItems: consideration.length,
    },
    signature: '0x' + '00'.repeat(65), // Mock signature
  };

  return JSON.stringify(order);
}

interface APIResponse {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    timestamp: string;
  };
}

// Helper for API requests
async function apiRequest(
  method: string,
  path: string,
  body?: any
): Promise<{ status: number; data: APIResponse }> {
  const url = `${API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json() as APIResponse;
  return { status: response.status, data };
}

describe('Brokered Listings API', () => {
  let minFeeBps: number;

  // Verify server is running and set up test data
  beforeAll(async () => {
    // Clean up any leftover test data from previous runs
    await cleanupTestListings();

    // Create ENS name records needed for the tests
    await createTestEnsNames();

    try {
      const response = await fetch(`${API_BASE}/config`);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const data = await response.json() as APIResponse;
      minFeeBps = data.data?.minFeeBasisPoints ?? 100;
    } catch {
      throw new Error(
        'API server not running. Start with: cd services/api && npm run dev'
      );
    }
  });

  // Clean up all test data after tests complete
  afterAll(async () => {
    await cleanupTestListings();
  });

  describe('GET /config', () => {
    it('returns broker fee configuration', async () => {
      const { status, data } = await apiRequest('GET', '/config');

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('minFeeBasisPoints');
      expect(data.data).toHaveProperty('minFeePercent');
      expect(typeof data.data.minFeeBasisPoints).toBe('number');
      expect(data.data.minFeeBasisPoints).toBeGreaterThanOrEqual(0);
      expect(data.data.minFeeBasisPoints).toBeLessThanOrEqual(10000);
      expect(data.data.minFeePercent).toBe(data.data.minFeeBasisPoints / 100);
    });
  });

  describe('POST / (Create Brokered Listing)', () => {
    describe('Validation Errors', () => {
      it('rejects when seller === broker (self-brokering)', async () => {
        const sameAddress = TEST_SELLER;
        const orderData = createMockOrderData({
          sellerAddress: sameAddress,
          brokerAddress: sameAddress,
          brokerFeeWei: '25000000000000000', // 0.025 ETH (2.5%)
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: '1000000000000000000',
          order_data: orderData,
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: sameAddress,
          broker_address: sameAddress,
          broker_fee_bps: 250,
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
        expect(data.error!.code).toBe('SELF_BROKER_NOT_ALLOWED');
        expect(data.error!.message).toContain('cannot be their own broker');
      });

      it('rejects broker fee below minimum', async () => {
        const lowFeeBps = Math.max(0, minFeeBps - 1);
        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei: '1000000000000000', // Very low fee
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: '1000000000000000000',
          order_data: orderData,
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: TEST_SELLER,
          broker_address: TEST_BROKER,
          broker_fee_bps: lowFeeBps,
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
        expect(data.error!.code).toBe('BROKER_FEE_TOO_LOW');
        expect(data.error!.message).toContain('basis points');
      });

      it('rejects when broker consideration item is missing from order', async () => {
        // Create order WITHOUT broker consideration
        const orderWithoutBroker = {
          parameters: {
            offerer: TEST_SELLER.toLowerCase(),
            zone: '0x0000000000000000000000000000000000000000',
            offer: [
              {
                itemType: 2,
                token: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
                identifierOrCriteria: TEST_TOKEN_ID,
                startAmount: '1',
                endAmount: '1',
              },
            ],
            consideration: [
              // Only seller, no broker
              {
                itemType: 0,
                token: '0x0000000000000000000000000000000000000000',
                identifierOrCriteria: '0',
                startAmount: '1000000000000000000',
                endAmount: '1000000000000000000',
                recipient: TEST_SELLER.toLowerCase(),
              },
            ],
            orderType: 0,
            startTime: Math.floor(Date.now() / 1000).toString(),
            endTime: (Math.floor(Date.now() / 1000) + 86400 * 7).toString(),
            zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
            salt: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
            conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
            totalOriginalConsiderationItems: 1,
          },
          signature: '0x' + '00'.repeat(65),
        };

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: '1000000000000000000',
          order_data: JSON.stringify(orderWithoutBroker),
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: TEST_SELLER,
          broker_address: TEST_BROKER,
          broker_fee_bps: 250,
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
        expect(data.error!.code).toBe('INVALID_FEE');
        expect(data.error!.message).toContain('broker');
      });

      it('rejects invalid seller address format', async () => {
        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei: '25000000000000000',
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: '1000000000000000000',
          order_data: orderData,
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: 'invalid-address',
          broker_address: TEST_BROKER,
          broker_fee_bps: 250,
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
      });

      it('rejects invalid broker address format', async () => {
        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei: '25000000000000000',
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: '1000000000000000000',
          order_data: orderData,
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: TEST_SELLER,
          broker_address: 'not-an-address',
          broker_fee_bps: 250,
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
      });

      it('rejects broker fee above 10000 basis points', async () => {
        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei: '25000000000000000',
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: '1000000000000000000',
          order_data: orderData,
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: TEST_SELLER,
          broker_address: TEST_BROKER,
          broker_fee_bps: 10001, // Over 100%
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
      });

      it('rejects missing required fields', async () => {
        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          // Missing other required fields
        });

        expect(status).toBe(400);
        expect(data.success).toBe(false);
      });

      it('returns 404 when ENS name does not exist', async () => {
        const nonExistentTokenId = '99999999999999999999999999999999999999999999999999999999999999999';
        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei: '25000000000000000',
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: nonExistentTokenId,
          price_wei: '1000000000000000000',
          order_data: orderData,
          order_hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
          seller_address: TEST_SELLER,
          broker_address: TEST_BROKER,
          broker_fee_bps: 250,
        });

        expect(status).toBe(404);
        expect(data.success).toBe(false);
        expect(data.error!.code).toBe('ENS_NAME_NOT_FOUND');
      });
    });

    describe('Successful Creation', () => {
      it('creates a brokered listing with valid data', async () => {
        const orderHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        const brokerFeeBps = Math.max(minFeeBps, 250); // At least min, or 2.5%
        const priceWei = '1000000000000000000'; // 1 ETH
        const brokerFeeWei = (BigInt(priceWei) * BigInt(brokerFeeBps) / BigInt(10000)).toString();

        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei,
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID,
          price_wei: priceWei,
          order_data: orderData,
          order_hash: orderHash,
          seller_address: TEST_SELLER,
          broker_address: TEST_BROKER,
          broker_fee_bps: brokerFeeBps,
        });

        expect(status).toBe(201);
        expect(data.success).toBe(true);
        expect(data.data).toHaveProperty('id');
        expect(data.data.broker_address).toBe(TEST_BROKER.toLowerCase());
        expect(data.data.broker_fee_bps).toBe(brokerFeeBps);
        expect(data.data.seller_address).toBe(TEST_SELLER.toLowerCase());
        expect(data.data.status).toBe('active');
        expect(data.data.source).toBe('grails');
      });

      it('creates listing with minimum allowed broker fee', async () => {
        const orderHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        const priceWei = '1000000000000000000';
        const brokerFeeWei = (BigInt(priceWei) * BigInt(minFeeBps) / BigInt(10000)).toString();

        const orderData = createMockOrderData({
          sellerAddress: TEST_SELLER,
          brokerAddress: TEST_BROKER,
          brokerFeeWei,
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID + '1', // Different token
          price_wei: priceWei,
          order_data: orderData,
          order_hash: orderHash,
          seller_address: TEST_SELLER,
          broker_address: TEST_BROKER,
          broker_fee_bps: minFeeBps,
        });

        expect(status).toBe(201);
        expect(data.success).toBe(true);
        expect(data.data.broker_fee_bps).toBe(minFeeBps);
      });

      it('normalizes addresses to lowercase', async () => {
        const upperSeller = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const upperBroker = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        const orderHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        const priceWei = '1000000000000000000';
        const brokerFeeWei = (BigInt(priceWei) * BigInt(250) / BigInt(10000)).toString();

        const orderData = createMockOrderData({
          sellerAddress: upperSeller,
          brokerAddress: upperBroker,
          brokerFeeWei,
        });

        const { status, data } = await apiRequest('POST', '/', {
          token_id: TEST_TOKEN_ID + '2',
          price_wei: priceWei,
          order_data: orderData,
          order_hash: orderHash,
          seller_address: upperSeller,
          broker_address: upperBroker,
          broker_fee_bps: 250,
        });

        expect(status).toBe(201);
        expect(data.data.seller_address).toBe(upperSeller.toLowerCase());
        expect(data.data.broker_address).toBe(upperBroker.toLowerCase());
      });
    });
  });

  describe('GET /broker/:address', () => {
    it('returns results for a broker address in standard search format', async () => {
      const { status, data } = await apiRequest('GET', `/broker/${TEST_BROKER}`);

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('results');
      expect(data.data).toHaveProperty('pagination');
      expect(Array.isArray(data.data.results)).toBe(true);
      expect(data.data.pagination).toHaveProperty('page');
      expect(data.data.pagination).toHaveProperty('limit');
      expect(data.data.pagination).toHaveProperty('total');
      expect(data.data.pagination).toHaveProperty('totalPages');

      // Verify results have standard search result format with listings
      if (data.data.results.length > 0) {
        const result = data.data.results[0];
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('token_id');
        expect(result).toHaveProperty('listings');
        // Listings should include broker fields
        if (result.listings.length > 0) {
          expect(result.listings[0]).toHaveProperty('broker_address');
          expect(result.listings[0]).toHaveProperty('broker_fee_bps');
        }
      }
    });

    it('returns results filtered by status', async () => {
      const { status, data } = await apiRequest(
        'GET',
        `/broker/${TEST_BROKER}?status=active`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);

      // All returned results should have active listings
      for (const result of data.data.results) {
        const hasActiveListing = result.listings?.some(
          (l: any) => l.status === 'active'
        );
        expect(hasActiveListing).toBe(true);
      }
    });

    it('supports pagination', async () => {
      const { status, data } = await apiRequest(
        'GET',
        `/broker/${TEST_BROKER}?page=1&limit=5`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.pagination.page).toBe(1);
      expect(data.data.pagination.limit).toBe(5);
      expect(data.data.results.length).toBeLessThanOrEqual(5);
    });

    it('returns empty array for address with no listings', async () => {
      const noListingsAddress = '0x0000000000000000000000000000000000000001';
      const { status, data } = await apiRequest(
        'GET',
        `/broker/${noListingsAddress}`
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.results).toEqual([]);
      expect(data.data.pagination.total).toBe(0);
    });

    it('rejects invalid address format', async () => {
      const { status, data } = await apiRequest(
        'GET',
        '/broker/invalid-address'
      );

      expect(status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error!.code).toBe('INVALID_ADDRESS');
    });

    it('normalizes address to lowercase for query', async () => {
      // Keep 0x lowercase, only uppercase the hex portion
      const mixedCaseAddress = '0x' + TEST_BROKER.slice(2).toUpperCase();
      const lowerAddress = TEST_BROKER.toLowerCase();

      const { status: mixedStatus, data: mixedData } = await apiRequest(
        'GET',
        `/broker/${mixedCaseAddress}`
      );
      const { status: lowerStatus, data: lowerData } = await apiRequest(
        'GET',
        `/broker/${lowerAddress}`
      );

      expect(mixedStatus).toBe(200);
      expect(lowerStatus).toBe(200);
      // Should return same results regardless of case
      expect(mixedData.data.pagination.total).toBe(lowerData.data.pagination.total);
    });
  });

  describe('GET /stats', () => {
    it('returns broker statistics', async () => {
      const { status, data } = await apiRequest('GET', '/stats');

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('activeBrokeredListings');
      expect(data.data).toHaveProperty('soldBrokeredListings');
      expect(data.data).toHaveProperty('uniqueBrokers');
      expect(data.data).toHaveProperty('averageBrokerFeeBps');

      expect(typeof data.data.activeBrokeredListings).toBe('number');
      expect(typeof data.data.soldBrokeredListings).toBe('number');
      expect(typeof data.data.uniqueBrokers).toBe('number');

      // Average can be null if no brokered listings exist
      if (data.data.averageBrokerFeeBps !== null) {
        expect(typeof data.data.averageBrokerFeeBps).toBe('number');
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles very large broker fee (just under 100%)', async () => {
      const orderHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
      const priceWei = '1000000000000000000';
      const brokerFeeBps = 9999; // 99.99%
      const brokerFeeWei = (BigInt(priceWei) * BigInt(brokerFeeBps) / BigInt(10000)).toString();

      const orderData = createMockOrderData({
        sellerAddress: TEST_SELLER,
        brokerAddress: TEST_BROKER,
        brokerFeeWei,
      });

      const { status, data } = await apiRequest('POST', '/', {
        token_id: TEST_TOKEN_ID + '3',
        price_wei: priceWei,
        order_data: orderData,
        order_hash: orderHash,
        seller_address: TEST_SELLER,
        broker_address: TEST_BROKER,
        broker_fee_bps: brokerFeeBps,
      });

      // Should succeed (no max fee enforcement currently)
      expect(status).toBe(201);
      expect(data.success).toBe(true);
    });

    it('handles order with complex consideration array', async () => {
      const orderHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
      const priceWei = '1000000000000000000';
      const platformFeeAddress = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
      const platformFeeWei = '25000000000000000'; // 2.5%
      const brokerFeeWei = '50000000000000000'; // 5%

      const orderData = createMockOrderData({
        sellerAddress: TEST_SELLER,
        brokerAddress: TEST_BROKER,
        brokerFeeWei,
        platformFeeAddress,
        platformFeeWei,
      });

      const { status, data } = await apiRequest('POST', '/', {
        token_id: TEST_TOKEN_ID + '4',
        price_wei: priceWei,
        order_data: orderData,
        order_hash: orderHash,
        seller_address: TEST_SELLER,
        broker_address: TEST_BROKER,
        broker_fee_bps: 500, // 5%
      });

      expect(status).toBe(201);
      expect(data.success).toBe(true);
    });

    it('handles duplicate order_hash by updating existing listing', async () => {
      const orderHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
      const priceWei = '1000000000000000000';
      const brokerFeeWei = '25000000000000000';

      const orderData = createMockOrderData({
        sellerAddress: TEST_SELLER,
        brokerAddress: TEST_BROKER,
        brokerFeeWei,
      });

      // Create first listing
      const { status: status1, data: data1 } = await apiRequest('POST', '/', {
        token_id: TEST_TOKEN_ID + '5',
        price_wei: priceWei,
        order_data: orderData,
        order_hash: orderHash,
        seller_address: TEST_SELLER,
        broker_address: TEST_BROKER,
        broker_fee_bps: 250,
      });

      expect(status1).toBe(201);
      const firstListingId = data1.data.id;

      // Create second listing with same order_hash - should update existing
      const newPriceWei = '2000000000000000000';
      const { status: status2, data: data2 } = await apiRequest('POST', '/', {
        token_id: TEST_TOKEN_ID + '5',
        price_wei: newPriceWei,
        order_data: orderData,
        order_hash: orderHash,
        seller_address: TEST_SELLER,
        broker_address: TEST_BROKER,
        broker_fee_bps: 250,
      });

      expect(status2).toBe(201);
      expect(data2.data.id).toBe(firstListingId); // Same listing updated (ON CONFLICT)
      expect(data2.data.price_wei).toBe(newPriceWei); // Price updated
    });
  });
});
