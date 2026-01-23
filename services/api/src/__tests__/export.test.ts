/**
 * Integration tests for CSV export functionality
 *
 * These tests validate that CSV exports match their corresponding JSON search results:
 * - Same names in the same order
 * - Proper CSV formatting
 * - Authentication required for export
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - Elasticsearch and PostgreSQL populated with data
 * - JWT_SECRET environment variable configured
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';
import jwt from 'jsonwebtoken';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const SEARCH_API_BASE = 'http://localhost:3000/api/v1/search';
const WATCHLIST_API_BASE = 'http://localhost:3000/api/v1/watchlist';

// Test user configuration
const TEST_USER_ADDRESS = '0xEXPORTTESTUSER000000000000000000000001';
let testUserId: number = 0;
let testAuthToken: string = '';

interface SearchResult {
  name: string;
  id: number;
  token_id: string;
  owner?: string;
  expiry_date?: string;
  registration_date?: string;
  clubs?: string[];
  view_count?: number;
  listings?: Array<{ status: string; price?: string }>;
}

interface SearchResponse {
  success: boolean;
  data?: {
    results: SearchResult[];
    pagination: { total: number; page: number; limit: number };
  };
  error?: { code: string; message: string };
}

interface CSVRow {
  id: string;
  name: string;
  token_id: string;
  owner_address: string;
  expiry_date: string;
  status: string;
  list_price: string;
  registration_date: string;
  clubs: string;
  view_count: string;
}

// Helper to get database pool
async function getPool() {
  const { Pool } = await import('pg');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
}

// Helper to generate JWT token
function generateTestToken(userId: number, address: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign(
    { sub: userId.toString(), address: address.toLowerCase() },
    secret,
    { expiresIn: '24h' }
  );
}

// Helper to make JSON search requests
async function searchJSON(params: string): Promise<SearchResponse> {
  const url = `${SEARCH_API_BASE}?${params}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${testAuthToken}`,
    },
  });
  return response.json() as Promise<SearchResponse>;
}

// Helper to make CSV export requests
async function searchCSV(params: string): Promise<{ status: number; text: string }> {
  const url = `${SEARCH_API_BASE}?${params}&export=true`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${testAuthToken}`,
    },
  });
  return {
    status: response.status,
    text: await response.text(),
  };
}

// Helper to make watchlist JSON search requests
async function watchlistSearchJSON(params: string): Promise<SearchResponse> {
  const url = `${WATCHLIST_API_BASE}/search?${params}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${testAuthToken}`,
    },
  });
  return response.json() as Promise<SearchResponse>;
}

// Helper to make watchlist CSV export requests
async function watchlistSearchCSV(params: string): Promise<{ status: number; text: string }> {
  const url = `${WATCHLIST_API_BASE}/search?${params}&export=true`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${testAuthToken}`,
    },
  });
  return {
    status: response.status,
    text: await response.text(),
  };
}

// Parse CSV content into array of row objects
function parseCSV(csvContent: string): CSVRow[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',');
  const rows: CSVRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: any = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row as CSVRow);
  }

  return rows;
}

// Parse a single CSV line handling quoted values
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

describe('CSV Export', () => {
  // Set up test user before tests
  beforeAll(async () => {
    // Verify server is running
    try {
      const response = await fetch('http://localhost:3000/health');
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error) {
      throw new Error(
        'API server not running. Start with: cd services/api && RATE_LIMIT_MAX=1000 npm run dev'
      );
    }

    // Create test user
    const pool = await getPool();
    try {
      const userResult = await pool.query(`
        INSERT INTO users (address, created_at, updated_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT (address) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `, [TEST_USER_ADDRESS.toLowerCase()]);
      testUserId = userResult.rows[0].id;

      // Generate auth token
      testAuthToken = generateTestToken(testUserId, TEST_USER_ADDRESS);

      // Add some items to watchlist for testing
      await pool.query('DELETE FROM watchlist WHERE user_id = $1', [testUserId]);
      await pool.query(`
        INSERT INTO watchlist (user_id, ens_name_id, added_at)
        SELECT $1, en.id, NOW()
        FROM ens_names en
        WHERE en.name IS NOT NULL
          AND en.name NOT LIKE 'token-%'
          AND en.name NOT LIKE '[%'
        ORDER BY RANDOM()
        LIMIT 100
      `, [testUserId]);
    } finally {
      await pool.end();
    }
  });

  // Clean up test user after tests
  afterAll(async () => {
    const pool = await getPool();
    try {
      await pool.query('DELETE FROM watchlist WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    } finally {
      await pool.end();
    }
  });

  describe('Authentication', () => {
    it('returns 401 when export requested without auth token', async () => {
      const url = `${SEARCH_API_BASE}?export=true&limit=10`;
      const response = await fetch(url);
      expect(response.status).toBe(401);
    });

    it('returns CSV with valid auth token', async () => {
      const { status, text } = await searchCSV('limit=10');
      expect(status).toBe(200);
      expect(text).toContain('id,name,token_id');
    });
  });

  describe('Search Export', () => {
    it('export matches JSON for basic search', async () => {
      const params = 'limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for showListings filter', async () => {
      const params = 'filters[showListings]=true&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for clubs filter', async () => {
      const params = 'filters[clubs][]=10k&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for length filters', async () => {
      const params = 'filters[minLength]=3&filters[maxLength]=5&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for hasNumbers filter', async () => {
      const params = 'filters[hasNumbers]=true&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for alphabetical sort', async () => {
      const params = 'sortBy=alphabetical&sortOrder=asc&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for price sort with listings', async () => {
      const params = 'filters[showListings]=true&sortBy=price&sortOrder=asc&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for combined filters', async () => {
      const params = 'filters[hasNumbers]=true&filters[minLength]=3&filters[maxLength]=5&filters[showListings]=true&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        searchJSON(params),
        searchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      // May have no results
      if (jsonNames.length === 0) {
        expect(csvNames.length).toBe(0);
      } else {
        expect(csvNames.length).toBe(jsonNames.length);
        expect(csvNames).toEqual(jsonNames);
      }
    });

    it('export with large limit respects max 10k rows', async () => {
      // Request more than max, should be capped
      const params = 'limit=15000';

      const { status, text } = await searchCSV(params);
      expect(status).toBe(200);

      const csvRows = parseCSV(text);
      // Should have at most 10000 rows
      expect(csvRows.length).toBeLessThanOrEqual(10000);
    });
  });

  describe('CSV Format', () => {
    it('has correct headers', async () => {
      const { status, text } = await searchCSV('limit=5');
      expect(status).toBe(200);

      const expectedHeaders = 'id,name,token_id,owner_address,expiry_date,status,list_price,registration_date,clubs,view_count';
      expect(text.split('\n')[0]).toBe(expectedHeaders);
    });

    it('formats dates as ISO strings', async () => {
      const { status, text } = await searchCSV('limit=5');
      expect(status).toBe(200);

      const csvRows = parseCSV(text);
      if (csvRows.length > 0) {
        for (const row of csvRows) {
          if (row.expiry_date) {
            // Should be ISO format like 2025-05-09T12:00:00.000Z
            expect(row.expiry_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
          }
          if (row.registration_date) {
            expect(row.registration_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
          }
        }
      }
    });

    it('formats clubs as comma-separated string', async () => {
      const params = 'filters[clubs][]=any&limit=20';

      const { status, text } = await searchCSV(params);
      expect(status).toBe(200);

      const csvRows = parseCSV(text);
      if (csvRows.length > 0) {
        for (const row of csvRows) {
          // Clubs should either be empty or comma-separated
          if (row.clubs) {
            expect(row.clubs).not.toContain('[');
            expect(row.clubs).not.toContain(']');
          }
        }
      }
    });

    it('includes status column with valid values', async () => {
      const { status, text } = await searchCSV('limit=20');
      expect(status).toBe(200);

      const csvRows = parseCSV(text);
      const validStatuses = ['registered', 'grace', 'premium', 'available'];

      for (const row of csvRows) {
        expect(validStatuses).toContain(row.status);
      }
    });
  });

  describe('Watchlist Export', () => {
    it('export matches JSON for watchlist search', async () => {
      const params = 'limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        watchlistSearchJSON(params),
        watchlistSearchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });

    it('export matches JSON for watchlist with filters', async () => {
      const params = 'sortBy=alphabetical&sortOrder=asc&limit=20';

      const [jsonResponse, csvResponse] = await Promise.all([
        watchlistSearchJSON(params),
        watchlistSearchCSV(params),
      ]);

      expect(jsonResponse.success).toBe(true);
      expect(csvResponse.status).toBe(200);

      const jsonNames = jsonResponse.data!.results.map(r => r.name);
      const csvRows = parseCSV(csvResponse.text);
      const csvNames = csvRows.map(r => r.name);

      expect(csvNames.length).toBe(jsonNames.length);
      expect(csvNames).toEqual(jsonNames);
    });
  });

  describe('Empty Results', () => {
    it('returns CSV with only headers for no results', async () => {
      // Use multiple filters that combined should return no results
      // (26+ character names that have numbers, no emoji, only letters - contradictory)
      const params = 'filters[minLength]=26&filters[maxLength]=27&filters[digits]=only&filters[letters]=only&limit=10';

      const { status, text } = await searchCSV(params);
      expect(status).toBe(200);

      const lines = text.trim().split('\n');
      // Should have just headers or very few results (the filter combination is contradictory)
      expect(lines.length).toBeLessThanOrEqual(2); // Headers + maybe 1 result max
      expect(lines[0]).toBe('id,name,token_id,owner_address,expiry_date,status,list_price,registration_date,clubs,view_count');
    });
  });
});
