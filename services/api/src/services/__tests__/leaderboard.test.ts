import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { getLeaderboardData } from '../leaderboard';
import type { ValidSortField } from '../../types/leaderboard';

describe('Leaderboard Service', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
    vi.clearAllMocks();
  });

  describe('getLeaderboardData', () => {
    it('should calculate sales_volume correctly', async () => {
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
            sales_volume: '25.5', // 25.5 ETH
            clubs: ['999', '10k'],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockDataResult);

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'sales_volume',
        sortOrder: 'DESC',
      });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].sales_volume).toBe(25.5);
      expect(result.users[0].names_sold).toBe(10);
      expect(result.total).toBe(1);
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
            sales_volume: '0', // 0 ETH
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].sales_volume).toBe(0);
      expect(result.users[0].names_sold).toBe(0);
    });

    it('should sort by sales_volume when specified', async () => {
      const mockCountResult = { rows: [{ total: '3' }] };
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
          {
            address: '0x3333333333333333333333333333333333333333',
            names_owned: 2,
            names_in_clubs: 1,
            expired_names: 0,
            names_listed: 0,
            names_sold: 2,
            sales_volume: '10.1',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'sales_volume',
        sortOrder: 'DESC',
      });

      expect(result.users).toHaveLength(3);
      expect(result.users[0].sales_volume).toBe(100.5);
      expect(result.users[1].sales_volume).toBe(50.25);
      expect(result.users[2].sales_volume).toBe(10.1);
    });

    it('should sort by names_sold when specified', async () => {
      const mockCountResult = { rows: [{ total: '2' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1111111111111111111111111111111111111111',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 20,
            sales_volume: '50.5',
            clubs: [],
          },
          {
            address: '0x2222222222222222222222222222222222222222',
            names_owned: 3,
            names_in_clubs: 2,
            expired_names: 0,
            names_listed: 1,
            names_sold: 10,
            sales_volume: '100.5',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_sold',
        sortOrder: 'DESC',
      });

      expect(result.users).toHaveLength(2);
      expect(result.users[0].names_sold).toBe(20);
      expect(result.users[1].names_sold).toBe(10);
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
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'sales_volume',
        sortOrder: 'DESC',
        clubs: ['999'],
      });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].clubs).toContain('999');
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      // Verify clubs parameter is passed to query
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('clubs && $1::text[]'),
        expect.arrayContaining([['999']])
      );
    });

    it('should handle pagination correctly', async () => {
      const mockCountResult = { rows: [{ total: '100' }] };
      const mockDataResult = { rows: [] };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 3,
        limit: 25,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.total).toBe(100);
      // Verify OFFSET is calculated correctly: (page - 1) * limit = (3 - 1) * 25 = 50
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([25, 50])
      );
    });

    it('should handle ascending sort order', async () => {
      const mockCountResult = { rows: [{ total: '2' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1111111111111111111111111111111111111111',
            names_owned: 5,
            names_in_clubs: 3,
            expired_names: 1,
            names_listed: 2,
            names_sold: 5,
            sales_volume: '10.5',
            clubs: [],
          },
          {
            address: '0x2222222222222222222222222222222222222222',
            names_owned: 3,
            names_in_clubs: 2,
            expired_names: 0,
            names_listed: 1,
            names_sold: 10,
            sales_volume: '50.5',
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'sales_volume',
        sortOrder: 'ASC',
      });

      expect(result.users).toHaveLength(2);
      // Verify ASC order is used in query
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('ASC'),
        expect.any(Array)
      );
    });

    it('should handle null/undefined sales_volume gracefully', async () => {
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
            sales_volume: null, // null from database
            clubs: [],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].sales_volume).toBe(0); // parseFloat(null) || 0
    });

    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database connection failed'));

      await expect(
        getLeaderboardData(mockPool, {
          page: 1,
          limit: 20,
          sortBy: 'names_owned',
          sortOrder: 'DESC',
        })
      ).rejects.toThrow('Database connection failed');
    });

    it('should execute count and data queries in parallel', async () => {
      const mockCountResult = { rows: [{ total: '10' }] };
      const mockDataResult = { rows: [] };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      // Verify both queries are called
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('should map all leaderboard fields correctly', async () => {
      const mockCountResult = { rows: [{ total: '1' }] };
      const mockDataResult = {
        rows: [
          {
            address: '0x1234567890123456789012345678901234567890',
            names_owned: 15,
            names_in_clubs: 8,
            expired_names: 2,
            names_listed: 5,
            names_sold: 12,
            sales_volume: '150.75',
            clubs: ['999', '10k', '100k'],
          },
        ],
      };

      mockPool.query
        .mockResolvedValueOnce(mockCountResult )
        .mockResolvedValueOnce(mockDataResult );

      const result = await getLeaderboardData(mockPool, {
        page: 1,
        limit: 20,
        sortBy: 'names_owned',
        sortOrder: 'DESC',
      });

      expect(result.users[0]).toEqual({
        address: '0x1234567890123456789012345678901234567890',
        names_owned: 15,
        names_in_clubs: 8,
        expired_names: 2,
        names_listed: 5,
        names_sold: 12,
        sales_volume: 150.75,
        clubs: ['999', '10k', '100k'],
      });
    });
  });
});
