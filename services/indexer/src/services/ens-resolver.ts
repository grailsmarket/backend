import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { namehash, labelhash } from 'viem/ens';
import { config, safeNormalize, isPlaceholderName } from '../../../shared/src';
import { logger } from '../utils/logger';

// Name Wrapper ABI - just the ownerOf function we need
const NAME_WRAPPER_ABI = [
  {
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

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
  /** Whether the name from The Graph was already in normalized form.
   *  If false, this is a "bad" registration (e.g., 'Vitalik.eth' with capital V)
   *  that should NOT be used to update ownership of the legitimate normalized name. */
  isNormalized: boolean;
  /** The original non-normalized name from The Graph (if different from normalized) */
  originalName: string | null;
}

export class ENSResolver {
  private cache = new Map<string, string>();
  private client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Query the Name Wrapper contract directly to get the true owner of a wrapped ENS name.
   * This bypasses The Graph and gives us authoritative blockchain data.
   *
   * @param ensName - Full ENS name (e.g., "vitalik.eth")
   * @returns The owner address, or null if not wrapped or query fails
   */
  async getWrappedNameOwner(ensName: string): Promise<string | null> {
    // Only works for valid .eth names, not placeholders
    if (!ensName || !ensName.endsWith('.eth') || ensName.startsWith('token-')) {
      return null;
    }

    try {
      // Compute the namehash - this is what the Name Wrapper uses as token ID
      const node = namehash(ensName);

      // Call ownerOf on the Name Wrapper contract
      const owner = await this.client.readContract({
        address: NAME_WRAPPER_ADDRESS as `0x${string}`,
        abi: NAME_WRAPPER_ABI,
        functionName: 'ownerOf',
        args: [BigInt(node)],
      });

      // Zero address means not wrapped or doesn't exist
      if (!owner || owner === '0x0000000000000000000000000000000000000000') {
        logger.debug(`Name ${ensName} is not wrapped (ownerOf returned zero)`);
        return null;
      }

      logger.debug(`Got wrapped owner for ${ensName} from contract: ${owner}`);
      return owner.toLowerCase();
    } catch (error: any) {
      // This can happen if the name doesn't exist in the wrapper
      logger.debug(`Error querying Name Wrapper for ${ensName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Compute the labelhash-based token ID for an ENS name.
   * This is the token ID used by the Base Registrar (ERC-721).
   *
   * @param ensName - Full ENS name (e.g., "vitalik.eth")
   * @returns The labelhash as a decimal string, or null if invalid
   */
  getLabelhashTokenId(ensName: string): string | null {
    if (!ensName || !ensName.endsWith('.eth')) {
      return null;
    }

    try {
      // Extract the label (e.g., "vitalik" from "vitalik.eth")
      const label = ensName.replace('.eth', '');
      if (!label) return null;

      // Compute labelhash and convert to decimal
      const hash = labelhash(label);
      return BigInt(hash).toString(10);
    } catch (error: any) {
      logger.debug(`Error computing labelhash for ${ensName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Compute the namehash-based token ID for an ENS name.
   * This is the token ID used by the Name Wrapper (ERC-1155).
   *
   * @param ensName - Full ENS name (e.g., "vitalik.eth")
   * @returns The namehash as a decimal string, or null if invalid
   */
  getNamehashTokenId(ensName: string): string | null {
    if (!ensName || !ensName.endsWith('.eth')) {
      return null;
    }

    try {
      const hash = namehash(ensName);
      return BigInt(hash).toString(10);
    } catch (error: any) {
      logger.debug(`Error computing namehash for ${ensName}: ${error.message}`);
      return null;
    }
  }

  async resolveTokenIdToName(tokenId: string): Promise<string | null> {
    // Check cache first
    const cached = this.cache.get(tokenId);
    if (cached) {
      return cached;
    }

    try {
      // The tokenId could be either:
      // 1. A labelhash (from Base Registrar events - unwrapped or the underlying NFT for wrapped names)
      // 2. A namehash (from Name Wrapper - wrapped names as ERC-1155)
      //
      // We try labelhash first (more common for .eth 2LDs), then fall back to namehash (id) lookup.
      const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
      const tokenIdAsHex = '0x' + hexString;

      logger.debug(`Resolving tokenId ${tokenId} (hex: ${tokenIdAsHex})`);

      const headers: any = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      // First, try to find by labelhash (Base Registrar token ID format)
      const labelhashQuery = `
        query GetENSNameByLabelhash($labelhash: String!) {
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

      let response = await fetch(config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: labelhashQuery,
          variables: { labelhash: tokenIdAsHex }
        }),
      });

      if (!response.ok) {
        logger.error(`Graph API error: ${response.status} ${response.statusText}`);
        return null;
      }

      let data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph query errors: ${JSON.stringify(data.errors, null, 2)}`);
        return null;
      }

      let domains = data.data?.domains || [];

      // If no results from labelhash lookup, try namehash (id) lookup
      // This handles Name Wrapper ERC-1155 token IDs which use namehash
      if (domains.length === 0) {
        logger.debug(`No results for labelhash ${tokenIdAsHex}, trying namehash (id) lookup`);

        const namehashQuery = `
          query GetENSNameByNamehash($namehash: String!) {
            domain(id: $namehash) {
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

        response = await fetch(config.theGraph.ensSubgraphUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: namehashQuery,
            variables: { namehash: tokenIdAsHex }
          }),
        });

        if (!response.ok) {
          logger.error(`Graph API error on namehash lookup: ${response.status} ${response.statusText}`);
          return null;
        }

        data = await response.json() as any;

        if (data.errors) {
          logger.error(`Graph namehash query errors: ${JSON.stringify(data.errors, null, 2)}`);
          return null;
        }

        // namehash query returns a single domain, not an array
        if (data.data?.domain) {
          domains = [data.data.domain];
          logger.debug(`Found domain via namehash lookup: ${data.data.domain.name}`);
        }
      }

      if (domains.length > 0) {
        const domain = domains[0];
        const rawName = domain.name || domain.labelName;

        if (rawName) {
          // Normalize the name per ENSIP-15
          const name = safeNormalize(rawName);

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
      // The tokenId could be either:
      // 1. A labelhash (from Base Registrar events - unwrapped or the underlying NFT for wrapped names)
      // 2. A namehash (from Name Wrapper - wrapped names as ERC-1155)
      //
      // We try labelhash first (more common for .eth 2LDs), then fall back to namehash (id) lookup.
      // See: https://docs.ens.domains/dapp-developer-guide/ens-as-nft

      const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
      const tokenIdAsHex = '0x' + hexString;

      logger.debug(`Resolving tokenId ${tokenId} (hex: ${tokenIdAsHex})`);

      const headers: any = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      // First, try to find by labelhash (Base Registrar token ID format)
      // This works for both unwrapped names and the underlying NFT of wrapped names
      const labelhashQuery = `
        query GetENSNameByLabelhash($labelhash: String!) {
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

      let response = await fetch(config.theGraph.ensSubgraphUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: labelhashQuery,
          variables: { labelhash: tokenIdAsHex }
        }),
      });

      if (!response.ok) {
        logger.error(`Graph API error: ${response.status} ${response.statusText}`);
        return null;
      }

      let data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph query errors: ${JSON.stringify(data.errors, null, 2)}`);
        return null;
      }

      let domains = data.data?.domains || [];

      // If no results from labelhash lookup, try namehash (id) lookup
      // This handles Name Wrapper ERC-1155 token IDs which use namehash
      if (domains.length === 0) {
        logger.debug(`No results for labelhash ${tokenIdAsHex}, trying namehash (id) lookup`);

        const namehashQuery = `
          query GetENSNameByNamehash($namehash: String!) {
            domain(id: $namehash) {
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

        response = await fetch(config.theGraph.ensSubgraphUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: namehashQuery,
            variables: { namehash: tokenIdAsHex }
          }),
        });

        if (!response.ok) {
          logger.error(`Graph API error on namehash lookup: ${response.status} ${response.statusText}`);
          return null;
        }

        data = await response.json() as any;

        if (data.errors) {
          logger.error(`Graph namehash query errors: ${JSON.stringify(data.errors, null, 2)}`);
          return null;
        }

        // namehash query returns a single domain, not an array
        if (data.data?.domain) {
          domains = [data.data.domain];
          logger.debug(`Found domain via namehash lookup: ${data.data.domain.name}`);
        }
      }

      if (domains.length > 0) {
        const domain = domains[0];
        const rawName = domain.name || domain.labelName;

        if (rawName) {
          // Normalize the name per ENSIP-15 (The Graph may return non-normalized names)
          const name = safeNormalize(rawName);

          // Check if the name was already normalized - if not, this is a "bad" registration
          // like "Vitalik.eth" (capital V) which should NOT be used to update ownership
          // of the legitimate normalized name "vitalik.eth"
          const isNormalized = rawName === name;
          const originalName = isNormalized ? null : rawName;

          if (!isNormalized) {
            logger.warn(`Detected non-normalized ENS registration: "${rawName}" -> "${name}". This may be an attempt to impersonate the legitimate name.`);
          }

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

          // Get owner address based on registrant
          // If registrant is NameWrapper, use wrappedOwner; otherwise use registrant
          let ownerAddress: string | null = null;
          if (domain.registrant?.id) {
            const registrant = domain.registrant.id.toLowerCase();
            if (registrant === NAME_WRAPPER_ADDRESS.toLowerCase()) {
              // Wrapped name: use wrappedOwner
              ownerAddress = domain.wrappedOwner?.id?.toLowerCase() || null;
            } else {
              // Unwrapped name: use registrant
              ownerAddress = registrant;
            }
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

          logger.info(`Resolved token ${tokenId} to name: ${name}, correctTokenId: ${correctTokenId}, expiry: ${expiryDate?.toISOString() || 'none'}, registration: ${registrationDate?.toISOString() || 'none'}, owner: ${ownerAddress || 'none'}, registrant: ${registrantAddress || 'none'}, wrapped: ${isOwnedByWrapper}, expired: ${isExpired}, text records: ${Object.keys(textRecords).length}, isNormalized: ${isNormalized}`);
          return { name, correctTokenId, expiryDate, ownerAddress, registrantAddress, registrationDate, textRecords, isNormalized, originalName };
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
          const rawName = domain.name || domain.labelName;
          if (rawName) {
            // Normalize the name per ENSIP-15
            const name = safeNormalize(rawName);
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