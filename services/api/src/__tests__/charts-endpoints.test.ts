import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';

interface ChartDataPoint {
  date: string;
  total: number | string;
  grails: number | string;
  opensea: number | string;
}

interface ChartResponse {
  success: boolean;
  data: {
    period: string;
    club: string | null;
    points: ChartDataPoint[];
  };
  meta: {
    timestamp: string;
    version: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

async function fetchEndpoint(path: string): Promise<ChartResponse> {
  const response = await fetch(`${API_BASE}${path}`);
  const data = await response.json();
  return data as ChartResponse;
}

describe('Chart Endpoints', () => {
  beforeAll(async () => {
    try {
      const response = await fetch('http://localhost:3000/health');
      if (!response.ok) {
        throw new Error('API server not running');
      }
    } catch (error) {
      console.error('API server is not running. Please start it with: npm run dev');
      throw error;
    }
  });

  describe('GET /charts/sales', () => {
    it('should return sales data with default parameters (7d)', async () => {
      const result = await fetchEndpoint('/charts/sales');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.period).toBe('7d');
      expect(result.data.club).toBeNull();
      expect(result.data.points).toBeInstanceOf(Array);
      expect(result.data.points.length).toBeGreaterThanOrEqual(7);
    });

    it('should return hourly data for 1d period', async () => {
      const result = await fetchEndpoint('/charts/sales?period=1d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('1d');
      expect(result.data.points.length).toBeGreaterThanOrEqual(24);
    });

    it('should return daily data for 7d period', async () => {
      const result = await fetchEndpoint('/charts/sales?period=7d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('7d');
      expect(result.data.points.length).toBeGreaterThanOrEqual(7);
    });

    it('should return daily data for 30d period', async () => {
      const result = await fetchEndpoint('/charts/sales?period=30d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('30d');
      expect(result.data.points.length).toBeGreaterThanOrEqual(30);
    });

    it('should return daily data for 1y period', async () => {
      const result = await fetchEndpoint('/charts/sales?period=1y');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('1y');
      expect(result.data.points.length).toBeGreaterThanOrEqual(365);
    });

    it('should filter by specific club', async () => {
      const result = await fetchEndpoint('/charts/sales?club=999');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('999');
    });

    it('should filter by any club', async () => {
      const result = await fetchEndpoint('/charts/sales?club=any');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('any');
    });

    it('should filter by no club (none)', async () => {
      const result = await fetchEndpoint('/charts/sales?club=none');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('none');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return data points with correct structure', async () => {
      const result = await fetchEndpoint('/charts/sales?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length > 0) {
        const point = result.data.points[0];
        expect(point.date).toBeDefined();
        expect(typeof point.total).toBe('number');
        expect(typeof point.grails).toBe('number');
        expect(typeof point.opensea).toBe('number');
      }
    });

    it('should return dates in ascending order', async () => {
      const result = await fetchEndpoint('/charts/sales?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeGreaterThan(dates[i - 1]);
        }
      }
    });

    it('should have no gaps in time series', async () => {
      const result = await fetchEndpoint('/charts/sales?period=7d');

      expect(result.success).toBe(true);
      // 7 days should give us at least 7 data points (one per day + today)
      expect(result.data.points.length).toBeGreaterThanOrEqual(7);

      // Check consecutive days
      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date));
        for (let i = 1; i < dates.length; i++) {
          const diff = dates[i].getTime() - dates[i - 1].getTime();
          const dayInMs = 24 * 60 * 60 * 1000;
          expect(diff).toBe(dayInMs);
        }
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/charts/sales?period=invalid`);
      expect(response.ok).toBe(false);
    });
  });

  describe('GET /charts/volume', () => {
    it('should return volume data with default parameters', async () => {
      const result = await fetchEndpoint('/charts/volume');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('7d');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return hourly data for 1d period', async () => {
      const result = await fetchEndpoint('/charts/volume?period=1d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(24);
    });

    it('should return volume as strings (wei precision)', async () => {
      const result = await fetchEndpoint('/charts/volume?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length > 0) {
        const point = result.data.points[0];
        expect(typeof point.total).toBe('string');
        expect(typeof point.grails).toBe('string');
        expect(typeof point.opensea).toBe('string');
      }
    });

    it('should filter by specific club', async () => {
      const result = await fetchEndpoint('/charts/volume?club=10k');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('10k');
    });

    it('should filter by any club', async () => {
      const result = await fetchEndpoint('/charts/volume?club=any');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('any');
    });

    it('should filter by no club (none)', async () => {
      const result = await fetchEndpoint('/charts/volume?club=none');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('none');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return dates in ascending order', async () => {
      const result = await fetchEndpoint('/charts/volume?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeGreaterThan(dates[i - 1]);
        }
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/charts/volume?period=invalid`);
      expect(response.ok).toBe(false);
    });
  });

  describe('GET /charts/listings', () => {
    it('should return listings data with default parameters', async () => {
      const result = await fetchEndpoint('/charts/listings');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('7d');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return hourly data for 1d period', async () => {
      const result = await fetchEndpoint('/charts/listings?period=1d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(24);
    });

    it('should return daily data for 30d period', async () => {
      const result = await fetchEndpoint('/charts/listings?period=30d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(30);
    });

    it('should filter by specific club', async () => {
      const result = await fetchEndpoint('/charts/listings?club=100k');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('100k');
    });

    it('should filter by any club', async () => {
      const result = await fetchEndpoint('/charts/listings?club=any');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('any');
    });

    it('should filter by no club (none)', async () => {
      const result = await fetchEndpoint('/charts/listings?club=none');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('none');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return data points with correct structure', async () => {
      const result = await fetchEndpoint('/charts/listings?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length > 0) {
        const point = result.data.points[0];
        expect(point.date).toBeDefined();
        expect(typeof point.total).toBe('number');
        expect(typeof point.grails).toBe('number');
        expect(typeof point.opensea).toBe('number');
      }
    });

    it('should return dates in ascending order', async () => {
      const result = await fetchEndpoint('/charts/listings?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeGreaterThan(dates[i - 1]);
        }
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/charts/listings?period=invalid`);
      expect(response.ok).toBe(false);
    });
  });

  describe('GET /charts/offers', () => {
    it('should return offers data with default parameters', async () => {
      const result = await fetchEndpoint('/charts/offers');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('7d');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return hourly data for 1d period', async () => {
      const result = await fetchEndpoint('/charts/offers?period=1d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(24);
    });

    it('should return daily data for 30d period', async () => {
      const result = await fetchEndpoint('/charts/offers?period=30d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(30);
    });

    it('should filter by specific club', async () => {
      const result = await fetchEndpoint('/charts/offers?club=999');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('999');
    });

    it('should filter by any club', async () => {
      const result = await fetchEndpoint('/charts/offers?club=any');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('any');
    });

    it('should filter by no club (none)', async () => {
      const result = await fetchEndpoint('/charts/offers?club=none');

      expect(result.success).toBe(true);
      expect(result.data.club).toBe('none');
      expect(result.data.points).toBeInstanceOf(Array);
    });

    it('should return data points with correct structure', async () => {
      const result = await fetchEndpoint('/charts/offers?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length > 0) {
        const point = result.data.points[0];
        expect(point.date).toBeDefined();
        expect(typeof point.total).toBe('number');
        expect(typeof point.grails).toBe('number');
        expect(typeof point.opensea).toBe('number');
      }
    });

    it('should return dates in ascending order', async () => {
      const result = await fetchEndpoint('/charts/offers?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeGreaterThan(dates[i - 1]);
        }
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/charts/offers?period=invalid`);
      expect(response.ok).toBe(false);
    });
  });
});
