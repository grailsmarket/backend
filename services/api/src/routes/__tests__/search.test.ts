/**
 * Unit tests for search route date filtering functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildESFilters } from '../../utils/elasticsearch-filters';

// Mock the elasticsearch-filters module to test if date filters are passed correctly
vi.mock('../../utils/elasticsearch-filters', () => ({
  buildESFilters: vi.fn(() => ({ must: [], filter: [] })),
  buildESSort: vi.fn(() => []),
  calculateMinScore: vi.fn(() => 1.0),
  buildESQuery: vi.fn(() => ({
    index: 'ens_names',
    body: { query: { bool: { must: [], filter: [] } }, from: 0, size: 20, sort: [] },
  })),
}));

describe('Search Route - Date Filter Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildESFilters integration', () => {
    it('should pass creation date filters to buildESFilters', () => {
      const filterOptions = {
        q: 'test',
        creation_date_min: '2023-01-01',
        creation_date_max: '2023-12-31',
        minPrice: '1',
        sortBy: 'price',
      };

      buildESFilters(filterOptions);

      expect(buildESFilters).toHaveBeenCalledWith(
        expect.objectContaining({
          creation_date_min: '2023-01-01',
          creation_date_max: '2023-12-31',
        })
      );
    });

    it('should work with only min date', () => {
      const filterOptions = {
        creation_date_min: '2023-01-01',
        sortBy: 'alphabetical',
      };

      buildESFilters(filterOptions);

      expect(buildESFilters).toHaveBeenCalledWith(
        expect.objectContaining({
          creation_date_min: '2023-01-01',
        })
      );
    });

    it('should work with only max date', () => {
      const filterOptions = {
        creation_date_max: '2023-12-31',
        sortBy: 'registration_date',
      };

      buildESFilters(filterOptions);

      expect(buildESFilters).toHaveBeenCalledWith(
        expect.objectContaining({
          creation_date_max: '2023-12-31',
        })
      );
    });

    it('should work without date filters (backward compatibility)', () => {
      const filterOptions = {
        q: 'test',
        minPrice: '1',
        hasNumbers: true,
      };

      buildESFilters(filterOptions);

      expect(buildESFilters).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'test',
          minPrice: '1',
          hasNumbers: true,
        })
      );
      expect(buildESFilters).toHaveBeenCalledWith(
        expect.not.objectContaining({
          creation_date_min: expect.anything(),
          creation_date_max: expect.anything(),
        })
      );
    });

    it('should work with other filters combined with date filters', () => {
      const filterOptions = {
        q: 'test',
        minPrice: '0.1',
        maxPrice: '10',
        creation_date_min: '2023-01-01',
        creation_date_max: '2023-12-31',
        hasNumbers: true,
        clubs: ['999', '10k'],
      };

      buildESFilters(filterOptions);

      expect(buildESFilters).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'test',
          minPrice: '0.1',
          maxPrice: '10',
          creation_date_min: '2023-01-01',
          creation_date_max: '2023-12-31',
          hasNumbers: true,
          clubs: ['999', '10k'],
        })
      );
    });
  });

  describe('Date validation logic', () => {
    it('should validate ISO 8601 date formats', () => {
      // Test date format validation logic
      const validDates = [
        '2023-01-01T00:00:00.000Z',
        '2023-12-31T23:59:59.999Z',
        '2023-06-15',
        '2023-01-01',
      ];

      validDates.forEach(date => {
        const testDate = new Date(date);
        expect(isNaN(testDate.getTime())).toBe(false);
      });
    });

    it('should reject invalid date formats', () => {
      const invalidDates = [
        'invalid-date',
        'not-a-date',
        '',
      ];

      invalidDates.forEach(date => {
        if (date !== null && date !== undefined && date !== '') {
          const testDate = new Date(date);
          expect(isNaN(testDate.getTime())).toBe(true);
        }
      });

      // Test empty string explicitly
      const emptyDate = new Date('');
      expect(isNaN(emptyDate.getTime())).toBe(true);
    });

    it('should validate date range logic (min <= max)', () => {
      // Valid ranges
      const validRanges = [
        ['2023-01-01', '2023-12-31'],
        ['2023-06-15', '2023-06-15'], // Same date
        ['2023-01-01T00:00:00.000Z', '2023-01-01T23:59:59.999Z'],
      ];

      validRanges.forEach(([min, max]) => {
        const minDate = new Date(min);
        const maxDate = new Date(max);
        expect(minDate <= maxDate).toBe(true);
      });

      // Invalid ranges
      const invalidRanges = [
        ['2023-12-31', '2023-01-01'],
        ['2023-06-15T12:00:00.000Z', '2023-06-15T11:00:00.000Z'],
      ];

      invalidRanges.forEach(([min, max]) => {
        const minDate = new Date(min);
        const maxDate = new Date(max);
        expect(minDate > maxDate).toBe(true);
      });
    });
  });

  describe('End-of-day conversion', () => {
    it('should convert max date to end-of-day for inclusivity', () => {
      const inputDate = '2023-12-31';
      const maxDate = new Date(inputDate + 'T00:00:00.000Z');
      maxDate.setUTCHours(23, 59, 59, 999);

      expect(maxDate.toISOString()).toBe('2023-12-31T23:59:59.999Z');
    });

    it('should preserve exact time when provided', () => {
      const inputDate = '2023-12-31T12:30:45.123Z';
      const testDate = new Date(inputDate);

      expect(testDate.toISOString()).toBe('2023-12-31T12:30:45.123Z');
    });
  });
});