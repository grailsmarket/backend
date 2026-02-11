/**
 * Integration tests for the Grails SDK
 *
 * These tests hit the real production API at api.grails.app
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GrailsClient } from '../../src/client.js';
import { NotFoundError } from '../../src/errors/api-error.js';

describe('Grails SDK Integration Tests', () => {
  let client: GrailsClient;

  beforeAll(() => {
    client = new GrailsClient();
  });

  describe('Search API', () => {
    it('should search for names', async () => {
      const results = await client.search.search({ q: 'eth' });

      expect(results).toBeDefined();
      expect(results.results).toBeInstanceOf(Array);
      expect(results.pagination).toBeDefined();
      expect(results.pagination.total).toBeGreaterThan(0);
    });

    it('should search with filters', async () => {
      const results = await client.search.search({
        q: 'test',
        minLength: 3,
        maxLength: 5,
        limit: 10,
      });

      expect(results.results).toBeInstanceOf(Array);
      // All results should have length between 3-5 (excluding .eth)
      for (const result of results.results) {
        const labelLength = result.label_name?.length ?? result.name.replace('.eth', '').length;
        expect(labelLength).toBeGreaterThanOrEqual(3);
        expect(labelLength).toBeLessThanOrEqual(5);
      }
    });

    it('should search with showListings filter', async () => {
      const results = await client.search.search({
        showListings: true,
        limit: 5,
      });

      expect(results.results).toBeInstanceOf(Array);
      // All results should have listings array with at least one listing
      for (const result of results.results) {
        expect(result.listings).toBeDefined();
        expect(result.listings.length).toBeGreaterThan(0);
      }
    });

    it('should handle bulk exact search', async () => {
      const results = await client.search.bulkExact({
        terms: ['vitalik', 'ethereum', 'wallet'],
      });

      expect(results).toBeDefined();
      expect(results.results).toBeInstanceOf(Array);
    });
  });

  describe('Names API', () => {
    it('should get name details', async () => {
      const name = await client.names.get('vitalik.eth');

      expect(name).toBeDefined();
      expect(name.name).toBe('vitalik.eth');
      expect(name.token_id).toBeDefined();
      expect(name.owner).toBeDefined();
    });

    it('should throw NotFoundError for non-existent name', async () => {
      await expect(
        client.names.get('thisdoesnotexist12345678.eth')
      ).rejects.toThrow(NotFoundError);
    });

    it('should get name metadata', async () => {
      const metadata = await client.names.getMetadata('vitalik.eth');

      expect(metadata).toBeDefined();
    });
  });

  describe('Listings API', () => {
    it('should list active listings', async () => {
      const listings = await client.listings.list({
        status: 'active',
        limit: 10,
      });

      expect(listings).toBeDefined();
      expect(listings.listings).toBeInstanceOf(Array);
      expect(listings.pagination).toBeDefined();
    });

    it('should get listings by name if available', async () => {
      // First find a name with listings
      const search = await client.search.search({
        showListings: true,
        limit: 1,
      });

      if (search.results.length > 0) {
        const nameWithListing = search.results[0].name;
        const listings = await client.listings.getByName(nameWithListing);

        expect(listings).toBeInstanceOf(Array);
        expect(listings.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Offers API', () => {
    it('should get offers by name', async () => {
      // Use a popular name that might have offers
      const offers = await client.offers.getByName('vitalik.eth');

      expect(offers).toBeDefined();
      expect(offers.offers).toBeInstanceOf(Array);
      expect(offers.pagination).toBeDefined();
    });
  });

  describe('Client Configuration', () => {
    it('should use custom base URL', async () => {
      const customClient = new GrailsClient({
        baseUrl: 'https://api.grails.app',
      });

      const results = await customClient.search.search({ q: 'test', limit: 1 });
      expect(results.results).toBeInstanceOf(Array);
    });

    it('should report not authenticated initially', () => {
      expect(client.isAuthenticated).toBe(false);
      expect(client.userAddress).toBeNull();
    });
  });
});
