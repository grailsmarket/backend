import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { getLeaderboardData } from '../leaderboard';
import type { LeaderboardUser } from '../../types/leaderboard';

// Mock pool
const createMockPool = () => {
  return {
    query: vi.fn(),
  } as unknown as Pool;
};

describe('Leaderboard Service', () => {
  let mockPool: Pool;

  beforeEach(() => {
    mockPool = createMockPool();
    vi.clearAllMocks();
  });

  describe('getLeaderboardData', () => {
    it('should calculate sales_volume correctly in ETH', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '2' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 2,
            expired_names: 0,
            names_listed: 1,
            names_sold: 3,
            sales_volume: '15.5', // 15.5 ETH
            clubs: ['999', '10k'],
          },
          {
            address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            names_owned: 3,
            names_in_clubs: 1,
            expired_names: 1,
            names_listed: 0,
            names_sold: 2,
            sales_volume: '8.25', // 8.25 ETH
            clubs: ['999'],
          },
        ],
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'sales_volume',
        sortOrder: 'DESC',
      });

      expect(result.total).toBe(2);
      expect(result.users).toHaveLength(2);
      expect(result.users[0].sales_volume).toBe(15.5);
      expect(result.users[1].sales_volume).toBe(8.25);
    });

    it('should handle zero sales_volume correctly', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '1' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 2,
            expired_names: 0,
            names_listed: 1,
            names_sold: 0,
            sales_volume: '0',
            clubs: ['999'],
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.users[0].sales_volume).toBe(0);
      expect(result.users[0].names_sold).toBe(0);
    });

    it('should support sales_volume sorting', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '3' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [
          {
            address: '0xaaaa',
            names_owned: 2,
            names_in_clubs: 0,
            expired_names: 0,
            names_listed: 0,
            names_sold: 5,
            sales_volume: '100.5',
            clubs: [],
          },
          {
            address: '0xbbbb',
            names_owned: 3,
            names_in_clubs: 0,
            expired_names: 0,
            names_listed: 0,
            names_sold: 3,
            sales_volume: '50.25',
            clubs: [],
          },
          {
            address: '0xcccc',
            names_owned: 1,
            names_in_clubs: 0,
            expired_names: 0,
            names_listed: 0,
            names_sold: 1,
            sales_volume: '10.0',
            clubs: [],
          },
        ],
        command: 'SELECT',
        rowCount: 3,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'sales_volume',
        sortOrder: 'DESC',
      });

      expect(result.users[0].sales_volume).toBe(100.5);
      expect(result.users[1].sales_volume).toBe(50.25);
      expect(result.users[2].sales_volume).toBe(10.0);
    });

    it('should support sales_count (names_sold) sorting', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '2' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [
          {
            address: '0xaaaa',
            names_owned: 2,
            names_in_clubs: 0,
            expired_names: 0,
            names_listed: 0,
            names_sold: 10,
            sales_volume: '50.0',
            clubs: [],
          },
          {
            address: '0xbbbb',
            names_owned: 3,
            names_in_clubs: 0,
            expired_names: 0,
            names_listed: 0,
            names_sold: 5,
            sales_volume: '100.0',
            clubs: [],
          },
        ],
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_sold',
        sortOrder: 'DESC',
      });

      expect(result.users[0].names_sold).toBe(10);
      expect(result.users[1].names_sold).toBe(5);
    });

    it('should handle club filtering', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '1' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 5,
            expired_names: 0,
            names_listed: 2,
            names_sold: 1,
            sales_volume: '25.0',
            clubs: ['999'],
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
        clubs: ['999'],
      });

      expect(result.total).toBe(1);
      expect(result.users[0].clubs).toContain('999');
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      // Verify clubs filter was passed to query
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('clubs && $1::text[]'),
        expect.arrayContaining([['999']])
      );
    });

    it('should handle pagination correctly', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '100' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 3,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.total).toBe(100);
      // Verify offset calculation: (page 3 - 1) * 20 = 40
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([20, 40])
      );
    });

    it('should handle database errors gracefully', async () => {
      (mockPool.query as any) = vi.fn().mockRejectedValueOnce(new Error('Database connection failed'));

      await expect(
        getLeaderboardData(mockPool, {
          page: 1,
          limit: 20,
          sortBy: 'names_owned',
          sortOrder: 'DESC',
        })
      ).rejects.toThrow('Database connection failed');
    });

    it('should handle null/undefined sales_volume', async () => {
      const mockCountResult: QueryResult = {
        rows: [{ total: '1' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 5,
            names_in_clubs: 2,
            expired_names: 0,
            names_listed: 1,
            names_sold: 0,
            sales_volume: null, // Null value from DB
            clubs: ['999'],
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      (mockPool.query as any) = vi.fn()
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.users[0].sales_volume).toBe(0);
    });

    it('should support all sort fields', async () => {
      const sortFields: Array<'names_owned' | 'names_in_clubs' | 'expired_names' | 'names_listed' | 'names_sold' | 'sales_volume'> = [
        'names_owned',
        'names_in_clubs',
        'expired_names',
        'names_listed',
        'names_sold',
        'sales_volume',
      ];

      const mockCountResult: QueryResult = {
        rows: [{ total: '0' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      };

      const mockDataResult: QueryResult = {
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      };

      for (const sortBy of sortFields) {
        (mockPool.query as any) = vi.fn()
          .mockResolvedValueOnce(mockCountResult)
          .mockResolvedValueOnce(mockDataResult);

        await getLeaderboardData(mockPool, {
          page: 1,
          limit: 20,
          sortBy,
          sortOrder: 'DESC',
        });

        expect(mockPool.query).toHaveBeenCalled();
        vi.clearAllMocks();
      }
    });
  });
});
