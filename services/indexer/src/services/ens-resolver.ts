import { config } from '../../../shared/src';
import { logger } from '../utils/logger';

// NOTE: The Graph has two expiry fields:
// - domain.expiryDate: includes 90-day grace period (END of grace period)
// - domain.registration.expiryDate: true expiry date (when name actually expires)
// We use domain.registration.expiryDate which gives us the correct expiry date.

interface ENSNameData {
  id: string;
  name: string | null;
  labelName: string | null;
  labelhash: string;
  owner?: {
    id: string;
  };
  expiryDate?: string;
  registration?: {
    expiryDate: string;
  };
}

const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

function hexToDecimal(hex: string): string {
  // Remove 0x prefix if present
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  // Convert hex string to decimal using BigInt
  return BigInt('0x' + cleanHex).toString(10);
}

interface ResolvedNameData {
  name: string;
  correctTokenId: string;
  expiryDate: Date | null;
  ownerAddress: string | null;
  registrantAddress: string | null;
  registrationDate: Date | null;
  textRecords: Record<string, string>;
}

export class ENSResolver {
  private cache = new Map<string, string>();

  clearCache(): void {
    this.cache.clear();
  }

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
          domains(where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }) {
            id
            name
            labelName
            labelhash
            registration {
              expiryDate
            }
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

  async resolveTokenIdToNameData(tokenId: string): Promise<ResolvedNameData | null> {
    try {
      // The tokenId is the NFT token ID from the ENS Registrar (in decimal)
      // Convert it to hex to get the labelhash for querying The Graph
      // Pad to 64 characters (32 bytes) for proper bytes32 format
      const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
      const labelhash = '0x' + hexString;

      logger.debug(`Resolving tokenId ${tokenId} with labelhash ${labelhash}`);

      const query = `
        query GetENSName($labelhash: String!) {
          domains(where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }) {
            id
            name
            labelName
            labelhash
            owner {
              id
            }
            expiryDate
            registrant {
              id
            }
            wrappedOwner {
              id
            }
            registration {
              expiryDate
              registrationDate
            }
            resolver {
              textChangeds {
                value
                key
              }
            }
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
          // Parse expiry date if available
          let expiryDate: Date | null = null;
          if (domain.registration?.expiryDate) {
            try {
              // The Graph returns timestamps as strings (Unix timestamp in seconds)
              // domain.registration.expiryDate is the true expiry (not including grace period)
              expiryDate = new Date(parseInt(domain.registration.expiryDate) * 1000);
            } catch (e) {
              logger.warn(`Failed to parse expiry date for ${name}: ${domain.registration.expiryDate}`);
            }
          }

          // Parse registration date if available
          let registrationDate: Date | null = null;
          if (domain.registration?.registrationDate) {
            try {
              registrationDate = new Date(parseInt(domain.registration.registrationDate) * 1000);
            } catch (e) {
              logger.warn(`Failed to parse registration date for ${name}: ${domain.registration.registrationDate}`);
            }
          }

          // Get owner address - prefer wrappedOwner if available, fallback to registrant
          let ownerAddress: string | null = null;
          if (domain.wrappedOwner?.id) {
            ownerAddress = domain.wrappedOwner.id.toLowerCase();
          } else if (domain.registrant?.id) {
            ownerAddress = domain.registrant.id.toLowerCase();
          }

          // Get registrant address (the original registerer of the name)
          let registrantAddress: string | null = null;
          if (domain.registrant?.id) {
            registrantAddress = domain.registrant.id.toLowerCase();
          }

          // Process text records - keep the last value for each key
          const textRecords: Record<string, string> = {};
          if (domain.resolver?.textChangeds && Array.isArray(domain.resolver.textChangeds)) {
            for (const record of domain.resolver.textChangeds) {
              if (record.key && record.value) {
                textRecords[record.key] = record.value;
              }
            }
          }

          // Calculate correct token_id based on wrapped/expired status
          // Logic: if owned by Name Wrapper and not expired, use domain.id; otherwise use labelhash
          let correctTokenId = tokenId; // Default to the input token_id (labelhash decimal)

          const ownerAddr = domain.owner?.id?.toLowerCase();
          const isOwnedByWrapper = ownerAddr === NAME_WRAPPER_ADDRESS.toLowerCase();

          // Check if expired - use domain.expiryDate which includes grace period
          let isExpired = false;
          if (domain.expiryDate) {
            try {
              const expiryTimestamp = typeof domain.expiryDate === 'string'
                ? parseInt(domain.expiryDate)
                : domain.expiryDate;
              isExpired = expiryTimestamp * 1000 < Date.now();
            } catch (e) {
              logger.warn(`Failed to check expiry for ${name}: ${domain.expiryDate}`);
            }
          }

          if (isOwnedByWrapper && !isExpired) {
            // For wrapped, non-expired names: use domain.id (the wrapped token ID)
            correctTokenId = hexToDecimal(domain.id);
            logger.debug(`Name ${name} is wrapped and not expired - using domain.id: ${correctTokenId}`);
          } else {
            // For unwrapped or expired names: use labelhash (already in tokenId)
            logger.debug(`Name ${name} is ${isExpired ? 'expired' : 'unwrapped'} - using labelhash: ${correctTokenId}`);
          }

          logger.info(`Resolved token ${tokenId} to name: ${name}, correctTokenId: ${correctTokenId}, expiry: ${expiryDate?.toISOString() || 'none'}, registration: ${registrationDate?.toISOString() || 'none'}, owner: ${ownerAddress || 'none'}, registrant: ${registrantAddress || 'none'}, wrapped: ${isOwnedByWrapper}, expired: ${isExpired}, text records: ${Object.keys(textRecords).length}`);
          return { name, correctTokenId, expiryDate, ownerAddress, registrantAddress, registrationDate, textRecords };
        }
      }

      logger.debug(`No name found for token ID: ${tokenId}`);
      return null;

    } catch (error: any) {
      logger.error(`Failed to resolve ENS name data for token ${tokenId}:`, error?.message);
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
          domains(where: { labelhash_in: $labelhashes, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }) {
            id
            name
            labelName
            labelhash
            registration {
              expiryDate
            }
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