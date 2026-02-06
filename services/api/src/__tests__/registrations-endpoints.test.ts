import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';

// Analytics registration response types
interface RegistrationSummary {
  registration_count: number;
  total_base_cost_wei: string;
  total_premium_wei: string;
  total_cost_wei: string;
  avg_base_cost_wei: string;
  avg_premium_wei: string;
  avg_cost_wei: string;
  premium_registrations: number;
  unique_registrants: number;
}

interface RegistrationByLength {
  name_length: number;
  count: number;
  total_cost_wei: string;
  avg_cost_wei: string;
  avg_base_cost_wei: string;
  avg_premium_wei: string;
}

interface RegistrationByLengthDetailed extends RegistrationByLength {
  min_cost_wei: string;
  max_cost_wei: string;
  median_cost_wei: string;
  premium_count: number;
}

interface RegistrationAnalyticsResponse {
  success: boolean;
  data: {
    period: string;
    summary: RegistrationSummary;
    by_length: RegistrationByLength[];
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

interface RegistrationByLengthResponse {
  success: boolean;
  data: {
    period: string;
    breakdown: RegistrationByLengthDetailed[];
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

// Charts registration response types
interface RegistrationChartPoint {
  date: string;
  count: number;
  total_cost_wei: string;
  avg_cost_wei: string;
  total_base_cost_wei: string;
  total_premium_wei: string;
  premium_count: number;
}

interface RegistrationChartResponse {
  success: boolean;
  data: {
    period: string;
    points: RegistrationChartPoint[];
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

async function fetchEndpoint<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  const data = await response.json();
  return data as T;
}

describe('Registration Endpoints', () => {
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

  describe('GET /analytics/registrations', () => {
    it('should return registration analytics with default parameters (7d)', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.period).toBe('7d');
      expect(result.data.summary).toBeDefined();
      expect(result.data.by_length).toBeInstanceOf(Array);
      expect(result.meta).toBeDefined();
      expect(result.meta.timestamp).toBeDefined();
    });

    it('should return correct summary structure', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations');

      expect(result.success).toBe(true);
      const summary = result.data.summary;

      // Check all expected fields exist
      expect(typeof summary.registration_count).toBe('number');
      expect(typeof summary.total_base_cost_wei).toBe('string');
      expect(typeof summary.total_premium_wei).toBe('string');
      expect(typeof summary.total_cost_wei).toBe('string');
      expect(typeof summary.avg_base_cost_wei).toBe('string');
      expect(typeof summary.avg_premium_wei).toBe('string');
      expect(typeof summary.avg_cost_wei).toBe('string');
      expect(typeof summary.premium_registrations).toBe('number');
      expect(typeof summary.unique_registrants).toBe('number');
    });

    it('should filter by period=24h', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=24h');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('24h');
    });

    it('should filter by period=30d', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=30d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('30d');
    });

    it('should filter by period=90d', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=90d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('90d');
    });

    it('should filter by period=all', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=all');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('all');
    });

    it('should return breakdown by name length', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations');

      expect(result.success).toBe(true);
      expect(result.data.by_length).toBeInstanceOf(Array);

      // If there's data, check structure
      if (result.data.by_length.length > 0) {
        const item = result.data.by_length[0];
        expect(typeof item.name_length).toBe('number');
        expect(typeof item.count).toBe('number');
        expect(typeof item.total_cost_wei).toBe('string');
        expect(typeof item.avg_cost_wei).toBe('string');
        expect(typeof item.avg_base_cost_wei).toBe('string');
        expect(typeof item.avg_premium_wei).toBe('string');
      }
    });

    it('should return by_length sorted by name_length ascending', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=all');

      expect(result.success).toBe(true);
      if (result.data.by_length.length >= 2) {
        const lengths = result.data.by_length.map(item => item.name_length);
        for (let i = 1; i < lengths.length; i++) {
          expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
        }
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/analytics/registrations?period=invalid`);
      expect(response.ok).toBe(false);
    });

    it('should have premium_registrations <= registration_count', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=all');

      expect(result.success).toBe(true);
      expect(result.data.summary.premium_registrations).toBeLessThanOrEqual(
        result.data.summary.registration_count
      );
    });
  });

  describe('GET /analytics/registrations/by-length', () => {
    it('should return detailed breakdown with default parameters', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.period).toBe('7d');
      expect(result.data.breakdown).toBeInstanceOf(Array);
    });

    it('should return detailed fields including min/max/median', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=all');

      expect(result.success).toBe(true);

      if (result.data.breakdown.length > 0) {
        const item = result.data.breakdown[0];
        expect(typeof item.name_length).toBe('number');
        expect(typeof item.count).toBe('number');
        expect(typeof item.total_cost_wei).toBe('string');
        expect(typeof item.avg_cost_wei).toBe('string');
        expect(typeof item.avg_base_cost_wei).toBe('string');
        expect(typeof item.avg_premium_wei).toBe('string');
        expect(typeof item.min_cost_wei).toBe('string');
        expect(typeof item.max_cost_wei).toBe('string');
        expect(typeof item.median_cost_wei).toBe('string');
        expect(typeof item.premium_count).toBe('number');
      }
    });

    it('should filter by period=24h', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=24h');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('24h');
    });

    it('should filter by period=30d', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=30d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('30d');
    });

    it('should filter by period=90d', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=90d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('90d');
    });

    it('should filter by period=all', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=all');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('all');
    });

    it('should return breakdown sorted by name_length ascending', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=all');

      expect(result.success).toBe(true);
      if (result.data.breakdown.length >= 2) {
        const lengths = result.data.breakdown.map(item => item.name_length);
        for (let i = 1; i < lengths.length; i++) {
          expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
        }
      }
    });

    it('should have min_cost <= median_cost <= max_cost', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=all');

      expect(result.success).toBe(true);
      for (const item of result.data.breakdown) {
        const min = BigInt(item.min_cost_wei);
        const median = BigInt(item.median_cost_wei);
        const max = BigInt(item.max_cost_wei);
        expect(min <= median).toBe(true);
        expect(median <= max).toBe(true);
      }
    });

    it('should have premium_count <= count', async () => {
      const result = await fetchEndpoint<RegistrationByLengthResponse>('/analytics/registrations/by-length?period=all');

      expect(result.success).toBe(true);
      for (const item of result.data.breakdown) {
        expect(item.premium_count).toBeLessThanOrEqual(item.count);
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/analytics/registrations/by-length?period=invalid`);
      expect(response.ok).toBe(false);
    });
  });

  describe('GET /charts/registrations', () => {
    it('should return registration chart data with default parameters (7d)', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.period).toBe('7d');
      expect(result.data.points).toBeInstanceOf(Array);
      expect(result.data.points.length).toBeGreaterThanOrEqual(7);
    });

    it('should return hourly data for 1d period', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=1d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('1d');
      expect(result.data.points.length).toBeGreaterThanOrEqual(24);
    });

    it('should return daily data for 7d period', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('7d');
      expect(result.data.points.length).toBeGreaterThanOrEqual(7);
    });

    it('should return daily data for 30d period', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=30d');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('30d');
      expect(result.data.points.length).toBeGreaterThanOrEqual(30);
    });

    it('should return daily data for 1y period', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=1y');

      expect(result.success).toBe(true);
      expect(result.data.period).toBe('1y');
      expect(result.data.points.length).toBeGreaterThanOrEqual(365);
    });

    it('should return data points with correct structure', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length > 0) {
        const point = result.data.points[0];
        expect(point.date).toBeDefined();
        expect(typeof point.count).toBe('number');
        expect(typeof point.total_cost_wei).toBe('string');
        expect(typeof point.avg_cost_wei).toBe('string');
        expect(typeof point.total_base_cost_wei).toBe('string');
        expect(typeof point.total_premium_wei).toBe('string');
        expect(typeof point.premium_count).toBe('number');
      }
    });

    it('should return dates in ascending order', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d');

      expect(result.success).toBe(true);
      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date).getTime());
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeGreaterThan(dates[i - 1]);
        }
      }
    });

    it('should have no gaps in time series (7d)', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(7);

      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date));
        for (let i = 1; i < dates.length; i++) {
          const diff = dates[i].getTime() - dates[i - 1].getTime();
          const dayInMs = 24 * 60 * 60 * 1000;
          expect(diff).toBe(dayInMs);
        }
      }
    });

    it('should have no gaps in time series (1d hourly)', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=1d');

      expect(result.success).toBe(true);
      expect(result.data.points.length).toBeGreaterThanOrEqual(24);

      if (result.data.points.length >= 2) {
        const dates = result.data.points.map((p) => new Date(p.date));
        for (let i = 1; i < dates.length; i++) {
          const diff = dates[i].getTime() - dates[i - 1].getTime();
          const hourInMs = 60 * 60 * 1000;
          expect(diff).toBe(hourInMs);
        }
      }
    });

    it('should have premium_count <= count for each point', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d');

      expect(result.success).toBe(true);
      for (const point of result.data.points) {
        expect(point.premium_count).toBeLessThanOrEqual(point.count);
      }
    });

    it('should return zero values for points with no data', async () => {
      const result = await fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d');

      expect(result.success).toBe(true);
      // Points without data should have zeros, not nulls
      for (const point of result.data.points) {
        expect(point.count).toBeGreaterThanOrEqual(0);
        expect(typeof point.total_cost_wei).toBe('string');
        expect(typeof point.avg_cost_wei).toBe('string');
      }
    });

    it('should reject invalid period', async () => {
      const response = await fetch(`${API_BASE}/charts/registrations?period=invalid`);
      expect(response.ok).toBe(false);
    });
  });

  describe('Data consistency', () => {
    it('should have consistent counts between analytics and charts', async () => {
      const [analytics, chart] = await Promise.all([
        fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=7d'),
        fetchEndpoint<RegistrationChartResponse>('/charts/registrations?period=7d'),
      ]);

      expect(analytics.success).toBe(true);
      expect(chart.success).toBe(true);

      // Sum of chart counts should equal analytics registration_count
      const chartTotal = chart.data.points.reduce((sum, p) => sum + p.count, 0);
      expect(chartTotal).toBe(analytics.data.summary.registration_count);
    });

    it('should have consistent by_length counts with total', async () => {
      const result = await fetchEndpoint<RegistrationAnalyticsResponse>('/analytics/registrations?period=all');

      expect(result.success).toBe(true);

      // Sum of by_length counts should equal total registration_count
      const byLengthTotal = result.data.by_length.reduce((sum, item) => sum + item.count, 0);
      expect(byLengthTotal).toBe(result.data.summary.registration_count);
    });
  });
});
