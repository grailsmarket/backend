import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { leaderboardRoutes } from '../leaderboard';

// Mock dependencies
vi.mock('../../../../shared/src', () => ({
  getPostgresPool: vi.fn(),
}));

vi.mock('../../middleware/cache', () => ({
  leaderboardCacheHandler: vi.fn((req: any, reply: any, done: any) => done()),
}));

import { getPostgresPool } from '../../../../shared/src';

describe('Leaderboard API Integration Tests', () => {
  let app: FastifyInstance;
  let mockPool: any;

  beforeEach(async () => {
    // Create mock pool
    mockPool = {
      query: vi.fn(),
    };

    (getPostgresPool as any).mockReturnValue(mockPool);

    // Create Fastify instance
    app = Fastify();
    await app.register(leaderboardRoutes, { prefix: '/api/v1/leaderboard' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('GET /api/v1/leaderboard', () => {
    it('should return leaderboard with sales_volume field', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 10,
            sales_volume: '25.5',
            clubs: ['999'],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.users).toHaveLength(1);
      expect(body.data.users[0]).toHaveProperty('sales_volume');
      expect(body.data.users[0].sales_volume).toBe(25.5);
    });

    it('should accept sortBy=sales_volume parameter', async () => {
      const mockCountResult = { rows: [{ total: '2' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1111111111111111111111111111111111111111',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 10,
            sales_volume: '100.5',
            clubs: [],
          },
          {
            address: '0x2222222222222222222222222222222222222222',
            names_owned: 3,
            names_in_clubs: 2,
            expired_names: 0,
            names_listed: 1,
            names_sold: 5,
            sales_volume: '50.25',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=sales_volume&sortOrder=desc',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.by).toBe('sales_volume');
      expect(body.meta.sort.order).toBe('desc');
      expect(body.data.users[0].sales_volume).toBe(100.5);
      expect(body.data.users[1].sales_volume).toBe(50.25);
    });

    it('should accept sortBy=names_sold parameter (backwards compatibility)', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 15,
            sales_volume: '50.5',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=names_sold&sortOrder=desc',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.by).toBe('names_sold');
      expect(body.data.users[0].names_sold).toBe(15);
    });

    it('should return error for invalid sortBy parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=invalid_field',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_SORT_FIELD');
      expect(body.error.message).toContain('Invalid sortBy field');
      expect(body.error.validOptions).toContain('sales_volume');
      expect(body.error.validOptions).toContain('names_sold');
    });

    it('should default to names_owned sorting when no sortBy is provided', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 10,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 5,
            sales_volume: '25.5',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.by).toBe('names_owned');
    });

    it('should handle pagination correctly', async () => {
      const mockCountResult = { rows: [{ total: '100' }] };
      const mockDataResult = { rows: [] };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?page=2&limit=25',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.pagination.page).toBe(2);
      expect(body.pagination.limit).toBe(25);
      expect(body.pagination.total).toBe(100);
      expect(body.pagination.pages).toBe(4);
    });

    it('should handle club filtering', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 10,
            sales_volume: '25.5',
            clubs: ['999'],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?clubs[]=999',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.filters).toBeDefined();
      expect(body.meta.filters.clubs).toContain('999');
    });

    it('should return sales_volume as numeric value in ETH', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 10,
            sales_volume: '123.456789', // ETH value with precision
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(typeof body.data.users[0].sales_volume).toBe('number');
      expect(body.data.users[0].sales_volume).toBe(123.456789);
    });

    it('should handle zero sales_volume correctly', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 0,
            sales_volume: '0',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.users[0].sales_volume).toBe(0);
      expect(body.data.users[0].names_sold).toBe(0);
    });

    it('should return proper API response format', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 10,
            sales_volume: '25.5',
            clubs: ['999'],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Verify response structure
      expect(body).toHaveProperty('success');
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(body).toHaveProperty('meta');

      // Verify data structure
      expect(body.data).toHaveProperty('users');
      expect(Array.isArray(body.data.users)).toBe(true);

      // Verify user object structure
      expect(body.data.users[0]).toHaveProperty('address');
      expect(body.data.users[0]).toHaveProperty('names_owned');
      expect(body.data.users[0]).toHaveProperty('names_in_clubs');
      expect(body.data.users[0]).toHaveProperty('expired_names');
      expect(body.data.users[0]).toHaveProperty('names_listed');
      expect(body.data.users[0]).toHaveProperty('names_sold');
      expect(body.data.users[0]).toHaveProperty('sales_volume');
      expect(body.data.users[0]).toHaveProperty('clubs');

      // Verify pagination structure
      expect(body.pagination).toHaveProperty('page');
      expect(body.pagination).toHaveProperty('limit');
      expect(body.pagination).toHaveProperty('total');
      expect(body.pagination).toHaveProperty('pages');

      // Verify meta structure
      expect(body.meta).toHaveProperty('timestamp');
      expect(body.meta).toHaveProperty('version');
      expect(body.meta).toHaveProperty('sort');
      expect(body.meta.sort).toHaveProperty('by');
      expect(body.meta.sort).toHaveProperty('order');
    });

    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it('should support ascending sort order', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 10,
            sales_volume: '25.5',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=sales_volume&sortOrder=asc',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.order).toBe('asc');
    });
  });
});
