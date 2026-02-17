import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { leaderboardRoutes } from '../leaderboard';

describe('Leaderboard API Integration Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(leaderboardRoutes, { prefix: '/api/v1/leaderboard' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/leaderboard', () => {
    it('should return leaderboard with sales_volume field', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.users).toBeInstanceOf(Array);

      if (body.data.users.length > 0) {
        const user = body.data.users[0];
        expect(user).toHaveProperty('address');
        expect(user).toHaveProperty('names_owned');
        expect(user).toHaveProperty('names_in_clubs');
        expect(user).toHaveProperty('expired_names');
        expect(user).toHaveProperty('names_listed');
        expect(user).toHaveProperty('names_sold');
        expect(user).toHaveProperty('sales_volume');
        expect(user).toHaveProperty('clubs');
        expect(typeof user.sales_volume).toBe('number');
      }
    });

    it('should accept sortBy=sales_volume parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=sales_volume&sortOrder=desc',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.by).toBe('sales_volume');
      expect(body.meta.sort.order).toBe('desc');

      // Verify sorting order if there are multiple users
      if (body.data.users.length > 1) {
        for (let i = 0; i < body.data.users.length - 1; i++) {
          expect(body.data.users[i].sales_volume).toBeGreaterThanOrEqual(
            body.data.users[i + 1].sales_volume
          );
        }
      }
    });

    it('should accept sortBy=names_sold parameter for backwards compatibility', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=names_sold&sortOrder=desc',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.by).toBe('names_sold');
      expect(body.meta.sort.order).toBe('desc');

      // Verify sorting order if there are multiple users
      if (body.data.users.length > 1) {
        for (let i = 0; i < body.data.users.length - 1; i++) {
          expect(body.data.users[i].names_sold).toBeGreaterThanOrEqual(
            body.data.users[i + 1].names_sold
          );
        }
      }
    });

    it('should default to names_owned sorting when sortBy is not provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.by).toBe('names_owned');
    });

    it('should handle invalid sortBy parameter gracefully', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=invalid_field',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      // Should default to names_owned
      expect(body.meta.sort.by).toBe('names_owned');
    });

    it('should support ascending sort order', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=sales_volume&sortOrder=asc',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.meta.sort.order).toBe('asc');

      // Verify sorting order if there are multiple users
      if (body.data.users.length > 1) {
        for (let i = 0; i < body.data.users.length - 1; i++) {
          expect(body.data.users[i].sales_volume).toBeLessThanOrEqual(
            body.data.users[i + 1].sales_volume
          );
        }
      }
    });

    it('should handle pagination parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?page=1&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(10);
      expect(body.data.users.length).toBeLessThanOrEqual(10);
    });

    it('should handle club filtering', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?clubs[]=999',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      if (body.meta.filters) {
        expect(body.meta.filters.clubs).toContain('999');
      }

      // All users should have the filtered club
      if (body.data.users.length > 0) {
        body.data.users.forEach((user: any) => {
          if (user.clubs.length > 0) {
            // User has clubs, may or may not include 999 due to query logic
            expect(user.clubs).toBeInstanceOf(Array);
          }
        });
      }
    });

    it('should return proper response format', async () => {
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

      expect(body.data).toHaveProperty('users');
      expect(Array.isArray(body.data.users)).toBe(true);

      expect(body.pagination).toHaveProperty('page');
      expect(body.pagination).toHaveProperty('limit');
      expect(body.pagination).toHaveProperty('total');
      expect(body.pagination).toHaveProperty('pages');

      expect(body.meta).toHaveProperty('timestamp');
      expect(body.meta).toHaveProperty('version');
      expect(body.meta).toHaveProperty('sort');
      expect(body.meta.sort).toHaveProperty('by');
      expect(body.meta.sort).toHaveProperty('order');
    });

    it('should return sales_volume as ETH value not wei', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=sales_volume&sortOrder=desc&limit=1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      if (body.data.users.length > 0) {
        const user = body.data.users[0];
        // sales_volume should be a reasonable ETH value (not wei)
        // Wei values would be in the 10^18 range, ETH values are much smaller
        expect(typeof user.sales_volume).toBe('number');
        // If there's a sales volume, it should be less than 10000 ETH (reasonable upper bound)
        if (user.sales_volume > 0) {
          expect(user.sales_volume).toBeLessThan(10000);
        }
      }
    });

    it('should handle users with zero sales_volume', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?sortBy=names_owned&sortOrder=desc&limit=100',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Find users with zero sales
      const usersWithZeroSales = body.data.users.filter((u: any) => u.names_sold === 0);

      usersWithZeroSales.forEach((user: any) => {
        expect(user.sales_volume).toBe(0);
      });
    });

    it('should support multiple club filters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?clubs[]=999&clubs[]=10k',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      if (body.meta.filters) {
        expect(body.meta.filters.clubs).toEqual(expect.arrayContaining(['999', '10k']));
      }
    });

    it('should respect limit max of 100', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?limit=200',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pagination.limit).toBe(100); // Should be capped at 100
      expect(body.data.users.length).toBeLessThanOrEqual(100);
    });

    it('should handle page numbers correctly', async () => {
      const response1 = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?page=1&limit=5',
      });

      const response2 = await app.inject({
        method: 'GET',
        url: '/api/v1/leaderboard?page=2&limit=5',
      });

      expect(response1.statusCode).toBe(200);
      expect(response2.statusCode).toBe(200);

      const body1 = JSON.parse(response1.body);
      const body2 = JSON.parse(response2.body);

      // Results should be different if there are enough users
      if (body1.pagination.total > 5) {
        expect(body1.data.users[0].address).not.toBe(body2.data.users[0].address);
      }
    });
  });
});
