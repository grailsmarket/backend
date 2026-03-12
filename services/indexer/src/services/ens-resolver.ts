import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { namehash, labelhash } from 'viem/ens';
import { config, safeNormalize, isPlaceholderName, processAddressRecords, type AddressRecord, needsEnsWorkerFallback, fetchTextRecordsFromEnsWorker } from '../../../shared/src';
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
  creationDate: Date | null;
  textRecords: Record<string, string>;
  addressRecords: AddressRecord[];
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
      // 1. A namehash (from Name Wrapper - wrapped names as ERC-1155, or subnames)
      // 2. A labelhash (from Base Registrar events - unwrapped 2LD .eth names)
      //
      // IMPORTANT: We try namehash FIRST because it's an exact match by domain ID.
      // This prevents collisions where a subname like "9604.holer.eth" could incorrectly
      // match "9604.eth" when querying by labelhash with parent=.eth filter.
      // Labelhash is the fallback for unwrapped 2LD names.
      const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
      const tokenIdAsHex = '0x' + hexString;

      logger.debug(`Resolving tokenId ${tokenId} (hex: ${tokenIdAsHex})`);

      const headers: any = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      // First, try to find by namehash (domain ID) - this is an exact match
      // Works for wrapped names, subnames, and any name identified by its namehash
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

      let response = await fetch(config.theGraph.ensSubgraphUrl, {
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

      let data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph namehash query errors: ${JSON.stringify(data.errors, null, 2)}`);
        return null;
      }

      let domains: any[] = [];

      // namehash query returns a single domain, not an array
      if (data.data?.domain) {
        domains = [data.data.domain];
        logger.debug(`Found domain via namehash lookup: ${data.data.domain.name}`);
      }

      // If no results from namehash lookup, try labelhash lookup
      // This handles unwrapped 2LD .eth names from the Base Registrar (ERC-721)
      if (domains.length === 0) {
        logger.debug(`No results for namehash ${tokenIdAsHex}, trying labelhash lookup`);

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

        response = await fetch(config.theGraph.ensSubgraphUrl, {
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

        data = await response.json() as any;

        if (data.errors) {
          logger.error(`Graph query errors: ${JSON.stringify(data.errors, null, 2)}`);
          return null;
        }

        domains = data.data?.domains || [];
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
      // 1. A namehash (from Name Wrapper - wrapped names as ERC-1155, or subnames)
      // 2. A labelhash (from Base Registrar events - unwrapped 2LD .eth names)
      //
      // IMPORTANT: We try namehash FIRST because it's an exact match by domain ID.
      // This prevents collisions where a subname like "9604.holer.eth" could incorrectly
      // match "9604.eth" when querying by labelhash with parent=.eth filter.
      // Labelhash is the fallback for unwrapped 2LD names.
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

      // First, try to find by namehash (domain ID) - this is an exact match
      // Works for wrapped names, subnames, and any name identified by its namehash
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
            createdAt
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
              address
              texts
              textChangeds {
                value
                key
              }
              addr {
                id
              }
              coinTypes
              multicoinAddrChangeds {
                coinType
                addr
              }
            }
          }
        }
      `;

      let response = await fetch(config.theGraph.ensSubgraphUrl, {
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

      let data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph namehash query errors: ${JSON.stringify(data.errors, null, 2)}`);
        return null;
      }

      let domains: any[] = [];

      // namehash query returns a single domain, not an array
      if (data.data?.domain) {
        domains = [data.data.domain];
        logger.debug(`Found domain via namehash lookup: ${data.data.domain.name}`);
      }

      // If no results from namehash lookup, try labelhash lookup
      // This handles unwrapped 2LD .eth names from the Base Registrar (ERC-721)
      if (domains.length === 0) {
        logger.debug(`No results for namehash ${tokenIdAsHex}, trying labelhash lookup`);

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
              createdAt
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
                address
                texts
                textChangeds {
                  value
                  key
                }
                addr {
                  id
                }
                coinTypes
                multicoinAddrChangeds {
                  coinType
                  addr
                }
              }
            }
          }
        `;

        response = await fetch(config.theGraph.ensSubgraphUrl, {
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

        data = await response.json() as any;

        if (data.errors) {
          logger.error(`Graph query errors: ${JSON.stringify(data.errors, null, 2)}`);
          return null;
        }

        domains = data.data?.domains || [];
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

          // Parse creation date if available (first-ever registration date)
          let creationDate: Date | null = null;
          if (domain.createdAt) {
            try {
              creationDate = new Date(parseInt(domain.createdAt) * 1000);
            } catch (e) {
              logger.warn(`Failed to parse creation date for ${name}: ${domain.createdAt}`);
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
          // If registrant is Name Wrapper, use wrappedOwner instead
          let registrantAddress: string | null = null;
          if (domain.registrant?.id) {
            const rawRegistrant = domain.registrant.id.toLowerCase();
            if (rawRegistrant === NAME_WRAPPER_ADDRESS.toLowerCase()) {
              registrantAddress = domain.wrappedOwner?.id?.toLowerCase() || null;
            } else {
              registrantAddress = rawRegistrant;
            }
          }

          // Process text records - keep the last value for each key
          // If a record's most recent value is null/empty, it means the user unset it
          const textRecords: Record<string, string> = {};
          if (domain.resolver?.textChangeds && Array.isArray(domain.resolver.textChangeds)) {
            for (const record of domain.resolver.textChangeds) {
              if (record.key) {
                if (record.value) {
                  textRecords[record.key] = record.value;
                } else {
                  // Value is null/empty - record was unset, remove it
                  delete textRecords[record.key];
                }
              }
            }
          }

          // Fallback to ENS worker if resolver doesn't emit values to The Graph
          if (needsEnsWorkerFallback(domain.resolver?.address, domain.resolver?.texts, domain.resolver?.textChangeds)) {
            try {
              const workerRecords = await fetchTextRecordsFromEnsWorker(name);
              Object.assign(textRecords, workerRecords);
              logger.info(`ENS worker fallback used for ${name}: ${Object.keys(workerRecords).length} text records`);
            } catch (error: any) {
              logger.warn(`ENS worker fallback failed for ${name}: ${error?.message}`);
            }
          }

          // Process address records (multicoinAddrChangeds)
          const addressRecords = processAddressRecords(domain.resolver?.multicoinAddrChangeds);

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

          logger.info(`Resolved token ${tokenId} to name: ${name}, correctTokenId: ${correctTokenId}, expiry: ${expiryDate?.toISOString() || 'none'}, registration: ${registrationDate?.toISOString() || 'none'}, owner: ${ownerAddress || 'none'}, registrant: ${registrantAddress || 'none'}, wrapped: ${isOwnedByWrapper}, expired: ${isExpired}, text records: ${Object.keys(textRecords).length}, address records: ${addressRecords.length}, isNormalized: ${isNormalized}`);
          return { name, correctTokenId, expiryDate, ownerAddress, registrantAddress, registrationDate, creationDate, textRecords, addressRecords, isNormalized, originalName };
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
      // Convert all token IDs to hex with proper padding
      const hexIds = uncached.map(id => {
        const hexString = BigInt(id).toString(16).padStart(64, '0');
        return '0x' + hexString;
      });

      const headers: any = {
        'Content-Type': 'application/json',
      };

      if (config.theGraph.apiKey) {
        headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
      }

      // IMPORTANT: Try namehash (id) lookup FIRST to prevent subname collisions.
      // This is an exact match by domain ID, which correctly handles subnames
      // like "9604.holer.eth" without incorrectly matching "9604.eth".
      const namehashQuery = `
        query GetENSNamesByNamehash($namehashes: [String!]!) {
          domains(where: { id_in: $namehashes }) {
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
          query: namehashQuery,
          variables: { namehashes: hexIds }
        }),
      });

      if (!response.ok) {
        logger.error(`Graph API error on namehash batch: ${response.status} ${response.statusText}`);
        // Return nulls for uncached items
        for (const tokenId of uncached) {
          results.set(tokenId, null);
        }
        return results;
      }

      let data = await response.json() as any;

      if (data.errors) {
        logger.error(`Graph namehash batch query errors: ${JSON.stringify(data.errors, null, 2)}`);
        // Return nulls for uncached items
        for (const tokenId of uncached) {
          results.set(tokenId, null);
        }
        return results;
      }

      let domains = data.data?.domains || [];

      // Create a map of namehash (id) to domain
      const namehashDomainMap = new Map<string, any>();
      for (const domain of domains) {
        if (domain.id) {
          namehashDomainMap.set(domain.id.toLowerCase(), domain);
        }
      }

      // Track which token IDs were NOT found by namehash lookup
      const notFoundByNamehash: string[] = [];
      const notFoundHexIds: string[] = [];

      for (let i = 0; i < uncached.length; i++) {
        const tokenId = uncached[i];
        const hexId = hexIds[i].toLowerCase();
        const domain = namehashDomainMap.get(hexId);

        if (domain) {
          const rawName = domain.name || domain.labelName;
          if (rawName) {
            const name = safeNormalize(rawName);
            this.cache.set(tokenId, name);
            results.set(tokenId, name);
            logger.debug(`Resolved token ${tokenId} to name via namehash: ${name}`);
          } else {
            results.set(tokenId, null);
          }
        } else {
          notFoundByNamehash.push(tokenId);
          notFoundHexIds.push(hexIds[i]);
        }
      }

      // Fall back to labelhash lookup for items not found by namehash
      // This handles unwrapped 2LD .eth names from the Base Registrar
      if (notFoundByNamehash.length > 0) {
        logger.debug(`${notFoundByNamehash.length} items not found by namehash, trying labelhash lookup`);

        const labelhashQuery = `
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

        response = await fetch(config.theGraph.ensSubgraphUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: labelhashQuery,
            variables: { labelhashes: notFoundHexIds }
          }),
        });

        if (!response.ok) {
          logger.error(`Graph API error on labelhash batch: ${response.status} ${response.statusText}`);
          // Return nulls for remaining items
          for (const tokenId of notFoundByNamehash) {
            results.set(tokenId, null);
          }
          return results;
        }

        data = await response.json() as any;

        if (data.errors) {
          logger.error(`Graph labelhash batch query errors: ${JSON.stringify(data.errors, null, 2)}`);
          for (const tokenId of notFoundByNamehash) {
            results.set(tokenId, null);
          }
          return results;
        }

        domains = data.data?.domains || [];

        // Create a map of labelhash to domain
        const labelhashDomainMap = new Map<string, any>();
        for (const domain of domains) {
          if (domain.labelhash) {
            labelhashDomainMap.set(domain.labelhash.toLowerCase(), domain);
          }
        }

        // Process remaining results
        for (let i = 0; i < notFoundByNamehash.length; i++) {
          const tokenId = notFoundByNamehash[i];
          const labelhash = notFoundHexIds[i].toLowerCase();
          const domain = labelhashDomainMap.get(labelhash);

          if (domain) {
            const rawName = domain.name || domain.labelName;
            if (rawName) {
              const name = safeNormalize(rawName);
              this.cache.set(tokenId, name);
              results.set(tokenId, name);
              logger.debug(`Resolved token ${tokenId} to name via labelhash: ${name}`);
            } else {
              results.set(tokenId, null);
            }
          } else {
            results.set(tokenId, null);
          }
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