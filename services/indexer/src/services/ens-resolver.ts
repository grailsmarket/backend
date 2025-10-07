import { config } from '../../../shared/src';
import { logger } from '../utils/logger';

interface ENSNameData {
  id: string;
  name: string | null;
  labelName: string | null;
  labelhash: string;
}

export class ENSResolver {
  private cache = new Map<string, string>();

  async resolveTokenIdToName(tokenId: string): Promise<string | null> {
    // Check cache first
    const cached = this.cache.get(tokenId);
    if (cached) {
      return cached;
    }

    try {
      // The tokenId is the NFT token ID from the ENS Registrar (in decimal)
      // Convert it to hex to get the labelhash for querying The Graph
      // Pad to 64 characters (32 bytes) for proper bytes32 format
      const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
      const labelhash = '0x' + hexString;

      logger.debug(`Resolving tokenId ${tokenId} with labelhash ${labelhash}`);

      const query = `
        query GetENSName($labelhash: String!) {
          domains(where: { labelhash: $labelhash }) {
            id
            name
            labelName
            labelhash
          }
        }
      `;

      const headers: any = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      const response = await fetch(config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables: { labelhash }
        }),
      });

      if (!response.ok) {
        logger.error(`Graph API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph query errors: ${JSON.stringify(data.errors, null, 2)}`);
        return null;
      }

      const domains = data.data?.domains || [];

      if (domains.length > 0) {
        const domain = domains[0];
        const name = domain.name || domain.labelName;

        if (name) {
          // Cache the result
          this.cache.set(tokenId, name);
          logger.info(`Resolved token ${tokenId} to name: ${name}`);
          return name;
        }
      }

      logger.debug(`No name found for token ID: ${tokenId}`);
      return null;

    } catch (error: any) {
      logger.error(`Failed to resolve ENS name for token ${tokenId}:`, error?.message);
      return null;
    }
  }

  async resolveBatch(tokenIds: string[]): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();

    // Filter out already cached items
    const uncached: string[] = [];
    for (const tokenId of tokenIds) {
      const cached = this.cache.get(tokenId);
      if (cached) {
        results.set(tokenId, cached);
      } else {
        uncached.push(tokenId);
      }
    }

    if (uncached.length === 0) {
      return results;
    }

    try {
      // Convert all token IDs to labelhashes with proper padding
      const labelhashes = uncached.map(id => {
        const hexString = BigInt(id).toString(16).padStart(64, '0');
        return '0x' + hexString;
      });

      const query = `
        query GetENSNames($labelhashes: [String!]!) {
          domains(where: { labelhash_in: $labelhashes }) {
            id
            name
            labelName
            labelhash
          }
        }
      `;

      const headers: any = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      const response = await fetch(config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables: { labelhashes }
        }),
      });

      if (!response.ok) {
        logger.error(`Graph API error: ${response.status} ${response.statusText}`);
        // Return nulls for uncached items
        for (const tokenId of uncached) {
          results.set(tokenId, null);
        }
        return results;
      }

      const data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph batch query errors: ${JSON.stringify(data.errors, null, 2)}`);
        // Return nulls for uncached items
        for (const tokenId of uncached) {
          results.set(tokenId, null);
        }
        return results;
      }

      const domains = data.data?.domains || [];

      // Create a map of labelhash to domain
      const domainMap = new Map<string, any>();
      for (const domain of domains) {
        if (domain.labelhash) {
          domainMap.set(domain.labelhash.toLowerCase(), domain);
        }
      }

      // Process results - map back to original token IDs
      for (const tokenId of uncached) {
        const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
        const labelhash = ('0x' + hexString).toLowerCase();
        const domain = domainMap.get(labelhash);

        if (domain) {
          const name = domain.name || domain.labelName;
          if (name) {
            this.cache.set(tokenId, name);
            results.set(tokenId, name);
            logger.debug(`Resolved token ${tokenId} to name: ${name}`);
          } else {
            results.set(tokenId, null);
          }
        } else {
          results.set(tokenId, null);
        }
      }

      return results;

    } catch (error: any) {
      logger.error(`Failed to resolve batch ENS names:`, error?.message);
      // Return nulls for uncached items
      for (const tokenId of uncached) {
        results.set(tokenId, null);
      }
      return results;
    }
  }
}