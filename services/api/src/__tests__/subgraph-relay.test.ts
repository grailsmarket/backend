/**
 * Integration tests for POST /api/v1/subgraph relay endpoint
 *
 * Tests the ENS subgraph relay functionality which:
 * - Accepts GraphQL queries via POST
 * - Forwards them to the configured ENS subgraph
 * - Returns the response from the subgraph
 *
 * Prerequisites:
 * - API server running on localhost:3000
 * - THE_GRAPH_ENS_SUBGRAPH_URL configured
 *
 * Run: npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'http://localhost:3000/api/v1/subgraph';

// Known ENS name for testing - 0xthrpw.eth
const TEST_ENS_NAME = '0xthrpw.eth';
const TEST_ENS_LABEL = '0xthrpw';
const TEST_ENS_ID = '0x66ef818b236726742a448b132e441c205ab22e426c34814f4d2b239616fb3c5b';
const TEST_ENS_CREATED_AT = '1716946079';
const TEST_ENS_RESOLVER_ADDRESS = '0x231b0ee14048e9dccd1d247744d114a4eb5e8e63';

interface SubgraphResponse {
  data?: any;
  errors?: Array<{ message: string }>;
  success?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

// Helper to make subgraph relay requests
async function querySubgraph(body: any): Promise<{ status: number; data: SubgraphResponse }> {
  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json() as SubgraphResponse;
  return { status: response.status, data };
}

describe('Subgraph Relay API', () => {
  // Verify server is running before tests
  beforeAll(async () => {
    try {
      const response = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      // Accept any response that isn't a connection error
      if (!response) {
        throw new Error('No response received');
      }
    } catch (error: any) {
      if (error.message?.includes('fetch failed') || error.cause?.code === 'ECONNREFUSED') {
        throw new Error(
          'API server not running. Start with: cd services/api && npm run dev'
        );
      }
      // Other errors are OK - the endpoint exists
    }
  });

  describe('Basic Functionality', () => {
    it('accepts valid GraphQL query and returns data', async () => {
      const { status, data } = await querySubgraph({
        query: '{ __typename }',
      });

      expect(status).toBe(200);
      expect(data.data).toBeDefined();
    });

    it('returns correct data for known ENS name', async () => {
      const { status, data } = await querySubgraph({
        query: `{
          domains(where: { name: "${TEST_ENS_NAME}" }) {
            id
            name
            labelName
            createdAt
            owner { id }
            resolver { id address }
          }
        }`,
      });

      expect(status).toBe(200);
      expect(data.data).toBeDefined();
      expect(data.data.domains).toBeInstanceOf(Array);
      expect(data.data.domains.length).toBe(1);

      const domain = data.data.domains[0];
      expect(domain.id).toBe(TEST_ENS_ID);
      expect(domain.name).toBe(TEST_ENS_NAME);
      expect(domain.labelName).toBe(TEST_ENS_LABEL);
      expect(domain.createdAt).toBe(TEST_ENS_CREATED_AT);
      expect(domain.resolver.address).toBe(TEST_ENS_RESOLVER_ADDRESS);
    });

    it('forwards query with variables', async () => {
      const { status, data } = await querySubgraph({
        query: `
          query GetDomain($name: String!) {
            domains(where: { name: $name }) {
              id
              name
            }
          }
        `,
        variables: { name: TEST_ENS_NAME },
      });

      expect(status).toBe(200);
      expect(data.data).toBeDefined();
      expect(data.data.domains).toBeInstanceOf(Array);
      expect(data.data.domains.length).toBe(1);
      expect(data.data.domains[0].name).toBe(TEST_ENS_NAME);
    });

    it('returns empty array for non-existent ENS name', async () => {
      const { status, data } = await querySubgraph({
        query: `{
          domains(where: { name: "thisnamedoesnotexist12345xyz.eth" }) {
            id
            name
          }
        }`,
      });

      expect(status).toBe(200);
      expect(data.data).toBeDefined();
      expect(data.data.domains).toBeInstanceOf(Array);
      expect(data.data.domains.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('returns GraphQL errors for invalid field queries', async () => {
      const { status, data } = await querySubgraph({
        query: '{ domains { invalidFieldThatDoesNotExist } }',
      });

      // GraphQL returns 200 with errors array for query errors
      expect(status).toBe(200);
      expect(data.errors).toBeDefined();
      expect(data.errors!.length).toBeGreaterThan(0);
    });

    it('handles malformed GraphQL query', async () => {
      const { status, data } = await querySubgraph({
        query: '{ this is not valid graphql',
      });

      // Malformed queries may return 200 with errors or 4xx/5xx from upstream
      // The important thing is we don't crash and return a response
      expect(typeof status).toBe('number');

      if (status === 200) {
        // GraphQL parse errors come back in errors array
        expect(data.errors).toBeDefined();
      }
    });

    it('handles empty query object', async () => {
      const { status } = await querySubgraph({});

      // Should handle gracefully - subgraph will return an error
      expect(typeof status).toBe('number');
    });
  });

  describe('Response Passthrough', () => {
    it('preserves full GraphQL response structure', async () => {
      const { status, data } = await querySubgraph({
        query: `{
          domains(where: { name: "${TEST_ENS_NAME}" }) {
            id
            name
            createdAt
            expiryDate
          }
        }`,
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty('data');
      expect(data.data.domains).toBeInstanceOf(Array);

      const domain = data.data.domains[0];
      expect(domain).toHaveProperty('id');
      expect(domain).toHaveProperty('name');
      expect(domain).toHaveProperty('createdAt');
      expect(domain).toHaveProperty('expiryDate');
    });

    it('returns paginated results correctly', async () => {
      const { status, data } = await querySubgraph({
        query: `{
          domains(first: 5, orderBy: createdAt, orderDirection: desc) {
            id
            name
          }
        }`,
      });

      expect(status).toBe(200);
      expect(data.data.domains).toBeInstanceOf(Array);
      expect(data.data.domains.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Complex Queries', () => {
    it('handles nested relationship queries', async () => {
      const { status, data } = await querySubgraph({
        query: `{
          domains(where: { name: "${TEST_ENS_NAME}" }) {
            id
            name
            owner {
              id
            }
            resolver {
              id
              address
            }
          }
        }`,
      });

      expect(status).toBe(200);
      expect(data.data.domains).toBeInstanceOf(Array);
      expect(data.data.domains.length).toBe(1);

      const domain = data.data.domains[0];
      expect(domain.owner).toBeDefined();
      expect(domain.owner.id).toBeDefined();
      expect(domain.resolver).toBeDefined();
      expect(domain.resolver.address).toBe(TEST_ENS_RESOLVER_ADDRESS);
    });

    it('handles registration queries', async () => {
      const { status, data } = await querySubgraph({
        query: `{
          registrations(first: 5, orderBy: registrationDate, orderDirection: desc) {
            id
            registrationDate
            expiryDate
            domain {
              name
            }
          }
        }`,
      });

      expect(status).toBe(200);
      expect(data.data.registrations).toBeInstanceOf(Array);
      expect(data.data.registrations.length).toBeGreaterThan(0);

      const registration = data.data.registrations[0];
      expect(registration).toHaveProperty('id');
      expect(registration).toHaveProperty('registrationDate');
      expect(registration).toHaveProperty('expiryDate');
      expect(registration.domain).toHaveProperty('name');
    });
  });
});
