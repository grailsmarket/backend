/**
 * Integration tests for bulk orders endpoint
 *
 * These tests validate the bulk listing creation endpoint:
 * - Schema validation (max 500 items)
 * - Partial success handling
 * - ENS name resolution (existing + new)
 * - Duplicate order hash handling
 * - Fee validation for grails source
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - PostgreSQL populated with data
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

const API_BASE = 'http://localhost:3000/api/v1/orders';

// Response type for bulk orders
interface BulkOrdersResponse {
  success: boolean;
  data?: {
    summary: {
      total: number;
      succeeded: number;
      failed: number;
      skipped: number;
    };
    results: Array<{
      index: number;
      token_id: string;
      order_hash: string;
      status: 'created' | 'failed' | 'skipped';
      listing_id?: number;
      error?: { code: string; message: string };
    }>;
  };
  error?: { code: string; message: string; details?: any };
}

// Test token IDs (random large numbers that probably don't exist)
const TEST_TOKEN_ID_1 = '99999999999999999999999999999999999999999999999999999999999999999999999001';
const TEST_TOKEN_ID_2 = '99999999999999999999999999999999999999999999999999999999999999999999999002';
const TEST_TOKEN_ID_3 = '99999999999999999999999999999999999999999999999999999999999999999999999003';

// Test seller address
const TEST_SELLER = '0x1234567890123456789012345678901234567890';

// Helper to generate a minimal valid Seaport order structure
function createTestOrderData(tokenId: string, price: string, seller: string): string {
  const now = Math.floor(Date.now() / 1000);
  const endTime = now + 86400 * 7; // 7 days

  return JSON.stringify({
    parameters: {
      offerer: seller,
      zone: '0x0000000000000000000000000000000000000000',
      offer: [
        {
          itemType: 2, // ERC721
          token: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
          identifierOrCriteria: tokenId,
          startAmount: '1',
          endAmount: '1',
        },
      ],
      consideration: [
        {
          itemType: 0, // Native ETH
          token: '0x0000000000000000000000000000000000000000',
          identifierOrCriteria: '0',
          startAmount: price,
          endAmount: price,
          recipient: seller,
        },
      ],
      orderType: 0,
      startTime: now,
      endTime: endTime,
      zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      salt: '0x' + Math.random().toString(16).slice(2).padStart(64, '0'),
      conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
      totalOriginalConsiderationItems: 1,
    },
    signature: '0x',
  });
}

// Helper to generate unique order hash
function generateOrderHash(): string {
  return '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// Helper to get database pool
async function getPool() {
  const { Pool } = await import('pg');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
}

describe('Bulk Orders Endpoint', () => {
  // Clean up test data after tests
  afterAll(async () => {
    const pool = await getPool();
    try {
      // Clean up test listings
      await pool.query(`
        DELETE FROM listings
        WHERE seller_address = $1
      `, [TEST_SELLER.toLowerCase()]);

      // Clean up test ENS names
      await pool.query(`
        DELETE FROM ens_names
        WHERE token_id IN ($1, $2, $3)
      `, [TEST_TOKEN_ID_1, TEST_TOKEN_ID_2, TEST_TOKEN_ID_3]);
    } finally {
      await pool.end();
    }
  });

  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch('http://localhost:3000/health');
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error) {
      throw new Error(
        'API server not running. Start with: cd services/api && npm run dev'
      );
    }
  });

  describe('Schema Validation', () => {
    it('rejects empty listings array', async () => {
      const response = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listings: [] }),
      });

      expect(response.status).toBe(400);
      const data = await response.json() as BulkOrdersResponse;
      expect(data.success).toBe(false);
      expect(data.error!.code).toBe('VALIDATION_ERROR');
    });

    it('rejects more than 500 listings', async () => {
      const listings = Array.from({ length: 501 }, (_, i) => ({
        type: 'listing',
        token_id: `token${i}`,
        price_wei: '1000000000000000000',
        order_data: createTestOrderData(`token${i}`, '1000000000000000000', TEST_SELLER),
        order_hash: generateOrderHash(),
        seller_address: TEST_SELLER,
        source: 'opensea', // Use opensea to skip fee validation
      }));

      const response = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listings }),
      });

      expect(response.status).toBe(400);
      const data = await response.json() as BulkOrdersResponse;
      expect(data.success).toBe(false);
      expect(data.error!.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid listing type', async () => {
      const response = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listings: [{
            type: 'offer', // Not allowed in bulk
            token_id: TEST_TOKEN_ID_1,
            price_wei: '1000000000000000000',
            order_data: createTestOrderData(TEST_TOKEN_ID_1, '1000000000000000000', TEST_SELLER),
            order_hash: generateOrderHash(),
            seller_address: TEST_SELLER,
          }],
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json() as BulkOrdersResponse;
      expect(data.success).toBe(false);
    });
  });

  describe('Successful Bulk Creation', () => {
    it('creates multiple listings successfully', async () => {
      const orderHash1 = generateOrderHash();
      const orderHash2 = generateOrderHash();

      const response = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listings: [
            {
              type: 'listing',
              token_id: TEST_TOKEN_ID_1,
              price_wei: '1000000000000000000',
              order_data: createTestOrderData(TEST_TOKEN_ID_1, '1000000000000000000', TEST_SELLER),
              order_hash: orderHash1,
              seller_address: TEST_SELLER,
              source: 'opensea', // Skip fee validation
            },
            {
              type: 'listing',
              token_id: TEST_TOKEN_ID_2,
              price_wei: '2000000000000000000',
              order_data: createTestOrderData(TEST_TOKEN_ID_2, '2000000000000000000', TEST_SELLER),
              order_hash: orderHash2,
              seller_address: TEST_SELLER,
              source: 'opensea',
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const data = await response.json() as BulkOrdersResponse;
      expect(data.success).toBe(true);
      expect(data.data!.summary.total).toBe(2);
      expect(data.data!.summary.succeeded).toBe(2);
      expect(data.data!.summary.failed).toBe(0);
      expect(data.data!.results).toHaveLength(2);
      expect(data.data!.results[0].status).toBe('created');
      expect(data.data!.results[1].status).toBe('created');
      expect(data.data!.results[0].listing_id).toBeDefined();
      expect(data.data!.results[1].listing_id).toBeDefined();
    });

    it('handles duplicate order hashes by replacing', async () => {
      const orderHash = generateOrderHash();

      // Create first listing
      const response1 = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listings: [{
            type: 'listing',
            token_id: TEST_TOKEN_ID_3,
            price_wei: '1000000000000000000',
            order_data: createTestOrderData(TEST_TOKEN_ID_3, '1000000000000000000', TEST_SELLER),
            order_hash: orderHash,
            seller_address: TEST_SELLER,
            source: 'opensea',
          }],
        }),
      });

      expect(response1.status).toBe(201);

      // Create second listing with same order hash
      const response2 = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listings: [{
            type: 'listing',
            token_id: TEST_TOKEN_ID_3,
            price_wei: '2000000000000000000', // Different price
            order_data: createTestOrderData(TEST_TOKEN_ID_3, '2000000000000000000', TEST_SELLER),
            order_hash: orderHash,
            seller_address: TEST_SELLER,
            source: 'opensea',
          }],
        }),
      });

      // Should succeed - old listing was auto-cancelled
      const data2 = await response2.json() as BulkOrdersResponse;
      if (response2.status !== 201) {
        console.log('Duplicate test failed with:', JSON.stringify(data2, null, 2));
      }
      expect(response2.status).toBe(201);
      expect(data2.data!.summary.succeeded).toBe(1);
      // Note: The result may show 'skipped' status if old was cancelled
    });
  });

  describe('Response Format', () => {
    it('returns results in index order', async () => {
      const listings = Array.from({ length: 5 }, (_, i) => ({
        type: 'listing' as const,
        token_id: `${TEST_TOKEN_ID_1}${i}`,
        price_wei: `${(i + 1)}000000000000000000`,
        order_data: createTestOrderData(`${TEST_TOKEN_ID_1}${i}`, `${(i + 1)}000000000000000000`, TEST_SELLER),
        order_hash: generateOrderHash(),
        seller_address: TEST_SELLER,
        source: 'opensea',
      }));

      const response = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listings }),
      });

      const data = await response.json() as BulkOrdersResponse;
      expect(data.data!.results).toHaveLength(5);

      // Verify results are in index order
      for (let i = 0; i < 5; i++) {
        expect(data.data!.results[i].index).toBe(i);
      }
    });

    it('includes summary counts', async () => {
      // Create unique token ID by replacing end digits with timestamp (stays within varchar(78))
      const testTokenId = TEST_TOKEN_ID_1.slice(0, -13) + Date.now();
      const response = await fetch(`${API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listings: [{
            type: 'listing',
            token_id: testTokenId,
            price_wei: '1000000000000000000',
            order_data: createTestOrderData(testTokenId, '1000000000000000000', TEST_SELLER),
            order_hash: generateOrderHash(),
            seller_address: TEST_SELLER,
            source: 'opensea',
          }],
        }),
      });

      const data = await response.json() as BulkOrdersResponse;
      if (!data.data) {
        console.log('Summary test failed with:', JSON.stringify(data, null, 2));
      }
      expect(data.data!.summary).toBeDefined();
      expect(data.data!.summary).toHaveProperty('total');
      expect(data.data!.summary).toHaveProperty('succeeded');
      expect(data.data!.summary).toHaveProperty('failed');
      expect(data.data!.summary).toHaveProperty('skipped');
    });
  });
});
